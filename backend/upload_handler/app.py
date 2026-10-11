import json
import os
import re
import uuid
from datetime import datetime, timezone
from urllib.parse import unquote_plus

import boto3
from botocore.exceptions import ClientError

AWS_REGION = os.environ.get("AWS_REGION", "ap-south-1")
s3 = boto3.client("s3", region_name=AWS_REGION)
dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
TABLE = dynamodb.Table(os.environ.get("TABLE_NAME", "cloudpix-local-test"))
BUCKET = os.environ.get("BUCKET_NAME", "cloudpix-local-test")
MAX_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", "10485760"))
ALLOWED = {"image/jpeg": ".jpg", "image/png": ".png"}
ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")


def response(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": ORIGIN,
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        },
        "body": json.dumps(body),
    }


def parse_body(event):
    body = event.get("body")
    if event.get("isBase64Encoded") and body:
        import base64
        body = base64.b64decode(body).decode("utf-8")
    if isinstance(body, str):
        return json.loads(body or "{}")
    return body or {}


def lambda_handler(event, context):
    method = event.get("httpMethod", "POST")
    if method == "OPTIONS":
        return response(200, {"ok": True})
    try:
        if method == "POST" and event.get("resource", "").endswith("/uploads"):
            return create_upload(parse_body(event))
        if method == "GET" and event.get("resource", "").endswith("/history"):
            return list_history()
        if method == "GET":
            image_id = (event.get("pathParameters") or {}).get("image_id")
            if image_id:
                return get_status(image_id)
        return response(404, {"error": "Endpoint not found"})
    except (ValueError, json.JSONDecodeError) as exc:
        return response(400, {"error": str(exc)})
    except Exception:
        print("Unhandled API error")
        return response(500, {"error": "Request failed. Check CloudWatch logs."})


def create_upload(data):
    filename = str(data.get("filename", "")).strip()
    content_type = str(data.get("content_type", "")).lower().strip()
    size = data.get("size")
    if not filename or len(filename) > 180:
        raise ValueError("A filename of 1–180 characters is required.")
    if content_type not in ALLOWED:
        raise ValueError("Only JPG/JPEG and PNG images are supported.")
    try:
        size = int(size)
    except (TypeError, ValueError):
        raise ValueError("A valid file size is required.")
    if size < 1 or size > MAX_BYTES:
        raise ValueError("Image must be between 1 byte and 10 MB.")
    # Treat the supplied name as display metadata only; never use it as an S3 key.
    image_id = str(uuid.uuid4())
    ext = ALLOWED[content_type]
    key = f"originals/{image_id}{ext}"
    timestamp = datetime.now(timezone.utc).isoformat()
    TABLE.put_item(Item={
        "image_id": image_id,
        "filename": filename,
        "uploaded_at": timestamp,
        "status": "Pending",
        "original_key": key,
        "content_type": content_type,
        "size_bytes": size,
    })
    try:
        upload_url = s3.generate_presigned_url(
            "put_object",
            Params={"Bucket": BUCKET, "Key": key, "ContentType": content_type},
            ExpiresIn=300,
        )
    except Exception:
        TABLE.update_item(
            Key={"image_id": image_id},
            UpdateExpression="SET #s = :failed, error_message = :msg",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":failed": "Failed", ":msg": "Could not create upload URL"},
        )
        raise
    return response(201, {
        "image_id": image_id, "upload_url": upload_url, "original_key": key,
        "uploaded_at": timestamp, "status": "Pending", "expires_in": 300,
    })


def sign_key(key):
    if not key:
        return None
    return s3.generate_presigned_url(
        "get_object", Params={"Bucket": BUCKET, "Key": key}, ExpiresIn=900
    )


def decorate(item):
    item = dict(item)
    for field in ("original_key", "resized_key", "thumbnail_key"):
        item[field.replace("_key", "_url")] = sign_key(item.get(field))
    return item


def list_history():
    # Small college-project history; scan is simple, and capped for response size.
    result = TABLE.scan(Limit=100)
    items = result.get("Items", [])
    items.sort(key=lambda x: x.get("uploaded_at", ""), reverse=True)
    return response(200, {"items": [decorate(i) for i in items[:100]]})


def get_status(image_id):
    result = TABLE.get_item(Key={"image_id": image_id})
    item = result.get("Item")
    if not item:
        return response(404, {"error": "Image not found"})
    return response(200, decorate(item))

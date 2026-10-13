"""CloudPix upload, history, status, download-URL, and deletion API."""
import json
import os
import uuid
from datetime import datetime, timezone

import boto3

AWS_REGION = os.environ.get("AWS_REGION", "ap-south-1")
s3 = boto3.client("s3", region_name=AWS_REGION)
dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
TABLE = dynamodb.Table(os.environ.get("TABLE_NAME", "cloudpix-local-test"))
BUCKET = os.environ.get("BUCKET_NAME", "cloudpix-local-test")
MAX_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", "10485760"))
ALLOWED = {"image/jpeg": ".jpg", "image/png": ".png"}
ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")
URL_EXPIRY = int(os.environ.get("DOWNLOAD_URL_EXPIRY", "900"))


def response(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": ORIGIN,
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        },
        "body": json.dumps(body, default=str),
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
    method = event.get("httpMethod", "POST").upper()
    resource = event.get("resource", "")
    if method == "OPTIONS":
        return response(200, {"ok": True})
    try:
        if method == "POST" and resource.endswith("/uploads"):
            return create_upload(parse_body(event))
        if method == "GET" and resource.endswith("/history"):
            return list_history()
        image_id = (event.get("pathParameters") or {}).get("image_id")
        if image_id and method == "GET":
            return get_status(image_id)
        if image_id and method == "DELETE":
            return delete_image(image_id)
        return response(404, {"error": "Endpoint not found"})
    except (ValueError, json.JSONDecodeError) as exc:
        return response(400, {"error": str(exc)})
    except Exception:
        import traceback
        traceback.print_exc()
        return response(500, {"error": "Request failed. Check CloudWatch logs."})


def create_upload(data):
    filename = str(data.get("filename", "")).strip()
    content_type = str(data.get("content_type", "")).lower().strip()
    try:
        size = int(data.get("size"))
    except (TypeError, ValueError):
        raise ValueError("A valid file size is required.")
    if not filename or len(filename) > 180:
        raise ValueError("A filename of 1–180 characters is required.")
    if content_type not in ALLOWED:
        raise ValueError("Only JPG/JPEG and PNG images are supported.")
    if size < 1 or size > MAX_BYTES:
        raise ValueError(f"Image must be between 1 byte and {MAX_BYTES // (1024 * 1024)} MB.")

    image_id = str(uuid.uuid4())
    key = f"originals/{image_id}{ALLOWED[content_type]}"
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
        "image_id": image_id,
        "upload_url": upload_url,
        "original_key": key,
        "uploaded_at": timestamp,
        "status": "Pending",
        "expires_in": 300,
    })


def sign_key(key, download_name=None):
    if not key:
        return None
    params = {"Bucket": BUCKET, "Key": key}
    if download_name:
        safe_name = str(download_name).replace('"', "").replace("\r", "").replace("\n", "")
        params["ResponseContentDisposition"] = f'attachment; filename="{safe_name}"'
    return s3.generate_presigned_url("get_object", Params=params, ExpiresIn=URL_EXPIRY)


def decorate(item):
    """Return display metadata and fresh, short-lived private-object URLs."""
    result = dict(item)
    base_name = os.path.splitext(str(result.get("filename") or "image"))[0]
    for field, label in (("original_key", "original"), ("resized_key", "resized"), ("thumbnail_key", "thumbnail")):
        result[field.replace("_key", "_url")] = sign_key(
            result.get(field), f"{base_name}-{label}{os.path.splitext(result.get(field) or '')[1]}"
        )
    # Consistent aliases are useful for UI clients and future API consumers.
    result["original_size_bytes"] = result.get("original_size_bytes", result.get("size_bytes"))
    return result


def list_history():
    result = TABLE.scan(Limit=100)
    items = result.get("Items", [])
    items.sort(key=lambda x: x.get("uploaded_at", ""), reverse=True)
    return response(200, {"items": [decorate(item) for item in items[:100]]})


def get_status(image_id):
    item = TABLE.get_item(Key={"image_id": image_id}).get("Item")
    if not item:
        return response(404, {"error": "Image not found"})
    return response(200, decorate(item))


def delete_image(image_id):
    """Delete an image's S3 variants and DynamoDB record; safe for partial records."""
    item = TABLE.get_item(Key={"image_id": image_id}).get("Item")
    if not item:
        return response(404, {"error": "Image not found"})

    keys = []
    for field in ("original_key", "resized_key", "thumbnail_key"):
        key = item.get(field)
        if key and key not in keys:
            keys.append(key)
    # Also remove known output objects if a previous processor failed before writing keys.
    for ext in ("jpeg", "png"):
        for variant in ("resized", "thumbnail"):
            key = f"processed/{image_id}/{variant}.{ext}"
            if key not in keys:
                keys.append(key)
    for key in keys:
        s3.delete_object(Bucket=BUCKET, Key=key)
    TABLE.delete_item(Key={"image_id": image_id})
    return response(200, {"deleted": True, "image_id": image_id, "deleted_objects": len(keys)})

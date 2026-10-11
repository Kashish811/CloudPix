import os
import urllib.parse
from datetime import datetime, timezone
from io import BytesIO

import boto3
from botocore.exceptions import ClientError
from PIL import Image, ImageOps, UnidentifiedImageError

AWS_REGION = os.environ.get("AWS_REGION", "ap-south-1")
s3 = boto3.client("s3", region_name=AWS_REGION)
dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
TABLE = dynamodb.Table(os.environ.get("TABLE_NAME", "cloudpix-local-test"))
BUCKET = os.environ.get("BUCKET_NAME", "cloudpix-local-test")
MAX_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", "10485760"))
MAX_PIXELS = 25_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


def make_variants(data):
    """Validate an encoded image and return resized and thumbnail JPEG/PNG bytes."""
    if len(data) > MAX_BYTES:
        raise ValueError("Image exceeds 10 MB limit.")
    try:
        with Image.open(BytesIO(data)) as source:
            if source.format not in ("JPEG", "PNG"):
                raise ValueError("Only JPEG and PNG content is supported.")
            source.verify()
        with Image.open(BytesIO(data)) as source:
            source = ImageOps.exif_transpose(source)
            source.load()
            if source.width * source.height > MAX_PIXELS:
                raise ValueError("Image dimensions exceed the allowed limit.")
            has_alpha = source.mode in ("RGBA", "LA") or (
                source.mode == "P" and "transparency" in source.info
            )
            if has_alpha:
                image = source.convert("RGBA")
                resized = image.copy()
                resized.thumbnail((800, 800), Image.Resampling.LANCZOS)
                thumb = image.copy()
                thumb.thumbnail((200, 200), Image.Resampling.LANCZOS)
                fmt = "PNG"
                mime = "image/png"
            else:
                image = source.convert("RGB")
                resized = image.copy()
                resized.thumbnail((800, 800), Image.Resampling.LANCZOS)
                thumb = image.copy()
                thumb.thumbnail((200, 200), Image.Resampling.LANCZOS)
                fmt = "JPEG"
                mime = "image/jpeg"
            out1, out2 = BytesIO(), BytesIO()
            options = {"optimize": True}
            if fmt == "JPEG":
                options["quality"] = 88
            resized.save(out1, format=fmt, **options)
            thumb.save(out2, format=fmt, **options)
            return out1.getvalue(), out2.getvalue(), mime, fmt.lower()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError("File is not a valid supported image.") from exc


def extract_created_objects(event):
    """Return (bucket, key) pairs from EventBridge or legacy S3 events.

    The deployed SAM template routes S3 Object Created events through
    EventBridge, whose payload uses ``detail`` rather than ``Records``.
    Supporting the legacy shape also makes local/manual testing easier.
    """
    if event.get("source") == "aws.s3":
        if event.get("detail-type") != "Object Created":
            return []
        detail = event.get("detail") or {}
        bucket = (detail.get("bucket") or {}).get("name")
        key = (detail.get("object") or {}).get("key", "")
        if not bucket or not key:
            return []
        # EventBridge carries the object key in detail.object.key. Do not
        # unquote '+' here: unlike legacy S3 notification records, this value
        # is treated as the object key as delivered by EventBridge.
        return [(bucket, key)]

    # Compatibility with traditional S3 notification test events.
    objects = []
    for record in event.get("Records", []):
        if record.get("eventSource") not in (None, "aws:s3"):
            continue
        bucket = (record.get("s3", {}).get("bucket") or {}).get("name")
        key = record.get("s3", {}).get("object", {}).get("key", "")
        if bucket and key:
            objects.append((bucket, urllib.parse.unquote_plus(key)))
    return objects


def lambda_handler(event, context):
    for bucket, key in extract_created_objects(event):
        if not key.startswith("originals/"):
            continue
        filename = key.rsplit("/", 1)[-1]
        if "." not in filename:
            print(f"Ignoring original object without extension: {key}")
            continue
        image_id = filename.rsplit(".", 1)[0]
        try:
            item = TABLE.get_item(Key={"image_id": image_id}).get("Item")
            if not item:
                print(f"No metadata record for object key {key}; ignoring event")
                continue
            # Idempotency: repeated notifications do not redo completed work.
            if item.get("status") == "Completed":
                continue
            TABLE.update_item(
                Key={"image_id": image_id},
                UpdateExpression="SET #s = :processing REMOVE error_message",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":processing": "Processing"},
            )
            obj = s3.get_object(Bucket=bucket, Key=key)
            data = obj["Body"].read(MAX_BYTES + 1)
            resized_data, thumb_data, mime, ext = make_variants(data)
            resized_key = f"processed/{image_id}/resized.{ext}"
            thumb_key = f"processed/{image_id}/thumbnail.{ext}"
            s3.put_object(Bucket=bucket, Key=resized_key, Body=resized_data, ContentType=mime)
            s3.put_object(Bucket=bucket, Key=thumb_key, Body=thumb_data, ContentType=mime)
            TABLE.update_item(
                Key={"image_id": image_id},
                UpdateExpression="SET #s = :done, resized_key = :r, thumbnail_key = :t, processed_at = :now",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={
                    ":done": "Completed", ":r": resized_key, ":t": thumb_key,
                    ":now": datetime.now(timezone.utc).isoformat(),
                },
            )
            print(f"Processed image {image_id}")
        except Exception as exc:
            print(f"Image processing failed for {image_id}: {type(exc).__name__}: {exc}")
            try:
                TABLE.update_item(
                    Key={"image_id": image_id},
                    UpdateExpression="SET #s = :failed, error_message = :msg, updated_at = :now",
                    ExpressionAttributeNames={"#s": "status"},
                    ExpressionAttributeValues={
                        ":failed": "Failed",
                        ":msg": str(exc)[:300],
                        ":now": datetime.now(timezone.utc).isoformat(),
                    },
                )
            except Exception as db_exc:
                # Raise so Lambda/S3 async invocation retries; logs aid diagnosis.
                print(f"Could not write failure status: {type(db_exc).__name__}")
                raise

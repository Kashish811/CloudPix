"""Event-driven CloudPix image validation, variant generation, and metadata storage."""
import os
import urllib.parse
from datetime import datetime, timezone
from io import BytesIO

import boto3
from PIL import Image, ImageOps, UnidentifiedImageError

AWS_REGION = os.environ.get("AWS_REGION", "ap-south-1")
s3 = boto3.client("s3", region_name=AWS_REGION)
dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
TABLE = dynamodb.Table(os.environ.get("TABLE_NAME", "cloudpix-local-test"))
MAX_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", "10485760"))
MAX_PIXELS = 25_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


def make_variants(data):
    """Return resized bytes, thumbnail bytes, MIME type, extension, and dimensions."""
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
            original_width, original_height = source.size
            has_alpha = source.mode in ("RGBA", "LA") or (source.mode == "P" and "transparency" in source.info)
            image = source.convert("RGBA" if has_alpha else "RGB")
            resized = image.copy()
            resized.thumbnail((800, 800), Image.Resampling.LANCZOS)
            thumb = image.copy()
            thumb.thumbnail((200, 200), Image.Resampling.LANCZOS)
            fmt = "PNG" if has_alpha else "JPEG"
            mime = "image/png" if has_alpha else "image/jpeg"
            options = {"optimize": True}
            if fmt == "JPEG":
                options["quality"] = 88
            out_resized, out_thumb = BytesIO(), BytesIO()
            resized.save(out_resized, format=fmt, **options)
            thumb.save(out_thumb, format=fmt, **options)
            return {
                "resized_data": out_resized.getvalue(),
                "thumbnail_data": out_thumb.getvalue(),
                "content_type": mime,
                "extension": fmt.lower(),
                "original_width": original_width,
                "original_height": original_height,
                "resized_width": resized.width,
                "resized_height": resized.height,
                "thumbnail_width": thumb.width,
                "thumbnail_height": thumb.height,
            }
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError("File is not a valid supported image.") from exc


def extract_created_objects(event):
    """Return (bucket, key) pairs from EventBridge or legacy S3 events."""
    if event.get("source") == "aws.s3":
        if event.get("detail-type") != "Object Created":
            return []
        detail = event.get("detail") or {}
        bucket = (detail.get("bucket") or {}).get("name")
        key = (detail.get("object") or {}).get("key", "")
        return [(bucket, key)] if bucket and key else []
    objects = []
    for record in event.get("Records", []):
        if record.get("eventSource") not in (None, "aws:s3"):
            continue
        bucket = (record.get("s3", {}).get("bucket") or {}).get("name")
        key = (record.get("s3", {}).get("object") or {}).get("key", "")
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
                continue
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
            if len(data) > MAX_BYTES:
                raise ValueError("Image exceeds 10 MB limit.")
            variants = make_variants(data)
            resized_key = f"processed/{image_id}/resized.{variants['extension']}"
            thumb_key = f"processed/{image_id}/thumbnail.{variants['extension']}"
            s3.put_object(Bucket=bucket, Key=resized_key, Body=variants["resized_data"], ContentType=variants["content_type"])
            s3.put_object(Bucket=bucket, Key=thumb_key, Body=variants["thumbnail_data"], ContentType=variants["content_type"])
            now = datetime.now(timezone.utc).isoformat()
            TABLE.update_item(
                Key={"image_id": image_id},
                UpdateExpression=(
                    "SET #s = :done, resized_key = :r, thumbnail_key = :t, processed_at = :now, "
                    "original_width = :ow, original_height = :oh, original_size_bytes = :os, "
                    "resized_width = :rw, resized_height = :rh, resized_size_bytes = :rs, "
                    "thumbnail_width = :tw, thumbnail_height = :th, thumbnail_size_bytes = :ts, "
                    "output_content_type = :mime"
                ),
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={
                    ":done": "Completed", ":r": resized_key, ":t": thumb_key, ":now": now,
                    ":ow": variants["original_width"], ":oh": variants["original_height"], ":os": len(data),
                    ":rw": variants["resized_width"], ":rh": variants["resized_height"], ":rs": len(variants["resized_data"]),
                    ":tw": variants["thumbnail_width"], ":th": variants["thumbnail_height"], ":ts": len(variants["thumbnail_data"]),
                    ":mime": variants["content_type"],
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
                        ":failed": "Failed", ":msg": str(exc)[:300],
                        ":now": datetime.now(timezone.utc).isoformat(),
                    },
                )
            except Exception as db_exc:
                print(f"Could not write failure status: {type(db_exc).__name__}")
                raise

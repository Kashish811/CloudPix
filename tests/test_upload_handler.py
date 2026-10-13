import json
import unittest
from unittest.mock import patch

from backend.upload_handler import app


def api_event(method, resource, body=None, image_id=None):
    return {
        "httpMethod": method,
        "resource": resource,
        "pathParameters": {"image_id": image_id} if image_id else {},
        "body": json.dumps(body) if body is not None else None,
    }


class UploadHandlerTests(unittest.TestCase):
    def test_upload_creates_record_and_returns_presigned_url(self):
        with patch.object(app.TABLE, "put_item") as put_item, patch.object(
            app.s3, "generate_presigned_url", return_value="https://s3.example/upload"
        ) as presign:
            result = app.lambda_handler(api_event(
                "POST", "/uploads", {"filename": "photo.jpg", "content_type": "image/jpeg", "size": 123}
            ), None)

        self.assertEqual(result["statusCode"], 201)
        payload = json.loads(result["body"])
        self.assertEqual(payload["upload_url"], "https://s3.example/upload")
        record = put_item.call_args.kwargs["Item"]
        self.assertEqual(record["size_bytes"], 123)
        self.assertTrue(record["original_key"].startswith("originals/"))
        presign.assert_called_once()

    def test_history_includes_fresh_named_download_urls_and_processor_metadata(self):
        item = {
            "image_id": "image-1", "filename": "photo.jpg", "original_key": "originals/image-1.jpg",
            "resized_key": "processed/image-1/resized.jpeg", "thumbnail_key": "processed/image-1/thumbnail.jpeg",
            "original_width": 1200, "resized_width": 800, "thumbnail_width": 200,
        }
        with patch.object(app.TABLE, "scan", return_value={"Items": [item]}), patch.object(
            app.s3, "generate_presigned_url", side_effect=["original-url", "resized-url", "thumbnail-url"]
        ) as presign:
            result = app.lambda_handler(api_event("GET", "/history"), None)

        record = json.loads(result["body"])["items"][0]
        self.assertEqual(result["statusCode"], 200)
        self.assertEqual(record["original_url"], "original-url")
        self.assertEqual(record["resized_url"], "resized-url")
        self.assertEqual(record["thumbnail_url"], "thumbnail-url")
        self.assertEqual(record["original_width"], 1200)
        self.assertEqual(record["resized_width"], 800)
        self.assertEqual(record["thumbnail_width"], 200)
        self.assertEqual(presign.call_count, 3)

    def test_status_route_returns_not_found_for_missing_image(self):
        with patch.object(app.TABLE, "get_item", return_value={}):
            result = app.lambda_handler(api_event("GET", "/images/{image_id}", image_id="missing"), None)
        self.assertEqual(result["statusCode"], 404)

    def test_options_has_cors_headers_without_authentication(self):
        result = app.lambda_handler({"httpMethod": "OPTIONS"}, None)
        self.assertEqual(result["statusCode"], 200)
        self.assertEqual(result["headers"]["Access-Control-Allow-Origin"], app.ORIGIN)
        self.assertEqual(result["headers"]["Access-Control-Allow-Methods"], "GET,POST,DELETE,OPTIONS")

    def test_invalid_upload_input_returns_client_error(self):
        result = app.lambda_handler(api_event("POST", "/uploads", {"filename": "bad.txt", "content_type": "text/plain", "size": 2}), None)
        self.assertEqual(result["statusCode"], 400)

    def test_delete_removes_known_s3_variants_then_dynamodb_record(self):
        image_id = "image-1"
        item = {
            "image_id": image_id,
            "original_key": f"originals/{image_id}.jpg",
            "resized_key": f"processed/{image_id}/resized.jpeg",
            "thumbnail_key": f"processed/{image_id}/thumbnail.jpeg",
        }
        call_order = []

        def delete_object(**kwargs):
            call_order.append(("s3", kwargs["Key"]))

        def delete_item(**kwargs):
            call_order.append(("dynamodb", kwargs["Key"]["image_id"]))

        with patch.object(app.TABLE, "get_item", return_value={"Item": item}), patch.object(
            app.s3, "delete_object", side_effect=delete_object
        ) as s3_delete, patch.object(app.TABLE, "delete_item", side_effect=delete_item) as db_delete:
            result = app.lambda_handler(api_event("DELETE", "/images/{image_id}", image_id=image_id), None)

        self.assertEqual(result["statusCode"], 200)
        self.assertEqual(json.loads(result["body"]), {"deleted": True, "image_id": image_id})
        self.assertEqual(s3_delete.call_count, 5)  # Three recorded keys and two fallback PNG variants.
        self.assertEqual(call_order[-1], ("dynamodb", image_id))
        db_delete.assert_called_once_with(Key={"image_id": image_id})

    def test_delete_missing_image_does_not_delete_s3_objects_or_record(self):
        with patch.object(app.TABLE, "get_item", return_value={}), patch.object(
            app.s3, "delete_object"
        ) as s3_delete, patch.object(app.TABLE, "delete_item") as db_delete:
            result = app.lambda_handler(api_event("DELETE", "/images/{image_id}", image_id="missing"), None)

        self.assertEqual(result["statusCode"], 404)
        s3_delete.assert_not_called()
        db_delete.assert_not_called()

    def test_delete_ignores_unexpected_keys_from_record(self):
        item = {
            "image_id": "image-1",
            "original_key": "unrelated/important.jpg",
            "resized_key": "processed/another-image/resized.jpeg",
        }
        with patch.object(app.TABLE, "get_item", return_value={"Item": item}), patch.object(
            app.s3, "delete_object"
        ) as s3_delete, patch.object(app.TABLE, "delete_item"):
            result = app.delete_image("image-1")

        self.assertEqual(result["statusCode"], 200)
        deleted_keys = [call.kwargs["Key"] for call in s3_delete.call_args_list]
        self.assertNotIn("unrelated/important.jpg", deleted_keys)
        self.assertTrue(all(key.startswith("processed/image-1/") for key in deleted_keys))

    def test_delete_keeps_record_when_s3_cleanup_fails(self):
        item = {"image_id": "image-1", "original_key": "originals/image-1.jpg"}
        with patch.object(app.TABLE, "get_item", return_value={"Item": item}), patch.object(
            app.s3, "delete_object", side_effect=RuntimeError("S3 unavailable")
        ), patch.object(app.TABLE, "delete_item") as db_delete:
            result = app.lambda_handler(api_event("DELETE", "/images/{image_id}", image_id="image-1"), None)

        self.assertEqual(result["statusCode"], 500)
        db_delete.assert_not_called()


if __name__ == "__main__":
    unittest.main()

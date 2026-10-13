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
        self.assertEqual(result["headers"]["Access-Control-Allow-Methods"], "GET,POST,OPTIONS")

    def test_invalid_upload_input_returns_client_error(self):
        result = app.lambda_handler(api_event("POST", "/uploads", {"filename": "bad.txt", "content_type": "text/plain", "size": 2}), None)
        self.assertEqual(result["statusCode"], 400)


if __name__ == "__main__":
    unittest.main()

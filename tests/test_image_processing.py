import io
import unittest
from unittest.mock import patch

from PIL import Image
from backend.image_processor.app import make_variants, extract_created_objects
from backend.upload_handler import app as upload_app


def image_bytes(size=(1200, 600), fmt="JPEG", mode="RGB"):
    image = Image.new(mode, size, (20, 100, 200, 100) if mode == "RGBA" else (20, 100, 200))
    out = io.BytesIO()
    image.save(out, format=fmt)
    return out.getvalue()


class ImageProcessingTests(unittest.TestCase):
    def test_resize_preserves_aspect_ratio_and_returns_metadata(self):
        result = make_variants(image_bytes())
        with Image.open(io.BytesIO(result["resized_data"])) as im:
            self.assertLessEqual(im.width, 800)
            self.assertLessEqual(im.height, 800)
            self.assertAlmostEqual(im.width / im.height, 2, delta=0.02)
        with Image.open(io.BytesIO(result["thumbnail_data"])) as im:
            self.assertLessEqual(im.width, 200)
            self.assertLessEqual(im.height, 200)
        self.assertEqual(result["content_type"], "image/jpeg")
        self.assertEqual(result["extension"], "jpeg")
        self.assertEqual((result["original_width"], result["original_height"]), (1200, 600))
        self.assertEqual((result["resized_width"], result["resized_height"]), (800, 400))
        self.assertEqual((result["thumbnail_width"], result["thumbnail_height"]), (200, 100))
        self.assertGreater(len(result["resized_data"]), 0)
        self.assertGreater(len(result["thumbnail_data"]), 0)

    def test_thumbnail_generation(self):
        result = make_variants(image_bytes((500, 500)))
        with Image.open(io.BytesIO(result["thumbnail_data"])) as im:
            self.assertEqual(im.size, (200, 200))

    def test_transparency_preserved(self):
        result = make_variants(image_bytes((300, 200), "PNG", "RGBA"))
        self.assertEqual(result["content_type"], "image/png")
        self.assertEqual(result["extension"], "png")
        with Image.open(io.BytesIO(result["resized_data"])) as im:
            self.assertEqual(im.mode, "RGBA")

    def test_unsupported_format_rejected(self):
        with self.assertRaises(ValueError):
            make_variants(image_bytes(fmt="BMP"))

    def test_corrupt_data_rejected(self):
        with self.assertRaises(ValueError):
            make_variants(b"not an image")

    def test_oversized_data_rejected(self):
        with self.assertRaises(ValueError):
            make_variants(b"x" * (10 * 1024 * 1024 + 1))

    def test_extract_eventbridge_s3_created_event(self):
        event = {"source": "aws.s3", "detail-type": "Object Created", "detail": {"bucket": {"name": "cloudpix-test"}, "object": {"key": "originals/abc-123.jpg"}}}
        self.assertEqual(extract_created_objects(event), [("cloudpix-test", "originals/abc-123.jpg")])

    def test_ignore_non_object_created_eventbridge_event(self):
        event = {"source": "aws.s3", "detail-type": "Object Deleted", "detail": {"bucket": {"name": "cloudpix-test"}, "object": {"key": "originals/abc-123.jpg"}}}
        self.assertEqual(extract_created_objects(event), [])

    def test_extract_legacy_s3_event(self):
        event = {"Records": [{"eventSource": "aws:s3", "s3": {"bucket": {"name": "cloudpix-test"}, "object": {"key": "originals%2Fabc-123.jpg"}}}]}
        self.assertEqual(extract_created_objects(event), [("cloudpix-test", "originals/abc-123.jpg")])


class UploadHandlerFeatureTests(unittest.TestCase):
    def test_decorate_adds_download_urls_and_size_alias(self):
        item = {"filename": "sample.png", "original_key": "originals/id.png", "resized_key": "processed/id/resized.png", "thumbnail_key": "processed/id/thumbnail.png", "size_bytes": 123}
        with patch.object(upload_app, "sign_key", side_effect=lambda key, name=None: f"signed:{key}:{name}"):
            decorated = upload_app.decorate(item)
        self.assertTrue(decorated["original_url"].startswith("signed:originals/id.png:"))
        self.assertTrue(decorated["resized_url"].startswith("signed:processed/id/resized.png:"))
        self.assertTrue(decorated["thumbnail_url"].startswith("signed:processed/id/thumbnail.png:"))
        self.assertEqual(decorated["original_size_bytes"], 123)

    def test_delete_image_removes_objects_and_database_item(self):
        item = {"image_id": "abc", "original_key": "originals/abc.jpg", "resized_key": "processed/abc/resized.jpeg", "thumbnail_key": "processed/abc/thumbnail.jpeg"}
        with patch.object(upload_app.TABLE, "get_item", return_value={"Item": item}), \
             patch.object(upload_app.TABLE, "delete_item") as db_delete, \
             patch.object(upload_app.s3, "delete_object") as s3_delete:
            result = upload_app.delete_image("abc")
        self.assertEqual(result["statusCode"], 200)
        self.assertEqual(len(s3_delete.call_args_list), 5)  # three known keys + fallback png variants
        db_delete.assert_called_once_with(Key={"image_id": "abc"})

    def test_delete_missing_image_returns_404(self):
        with patch.object(upload_app.TABLE, "get_item", return_value={}):
            result = upload_app.delete_image("missing")
        self.assertEqual(result["statusCode"], 404)

    def test_lambda_routes_delete_request(self):
        with patch.object(upload_app, "delete_image", return_value={"statusCode": 200, "body": "{}"}) as delete:
            result = upload_app.lambda_handler({"httpMethod": "DELETE", "pathParameters": {"image_id": "abc"}}, None)
        self.assertEqual(result["statusCode"], 200)
        delete.assert_called_once_with("abc")


if __name__ == "__main__":
    unittest.main()

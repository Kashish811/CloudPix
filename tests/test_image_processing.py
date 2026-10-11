import io
import unittest
from PIL import Image
from backend.image_processor.app import make_variants, extract_created_objects


def image_bytes(size=(1200, 600), fmt="JPEG", mode="RGB"):
    image = Image.new(mode, size, (20, 100, 200, 100) if mode == "RGBA" else (20, 100, 200))
    out = io.BytesIO()
    image.save(out, format=fmt)
    return out.getvalue()


class ImageProcessingTests(unittest.TestCase):
    def test_resize_preserves_aspect_ratio(self):
        resized, thumb, mime, ext = make_variants(image_bytes())
        with Image.open(io.BytesIO(resized)) as im:
            self.assertLessEqual(*im.size[::-1]) if False else None
            self.assertLessEqual(im.width, 800)
            self.assertLessEqual(im.height, 800)
            self.assertAlmostEqual(im.width / im.height, 2, delta=0.02)
        with Image.open(io.BytesIO(thumb)) as im:
            self.assertLessEqual(im.width, 200)
            self.assertLessEqual(im.height, 200)
        self.assertEqual(mime, "image/jpeg")
        self.assertEqual(ext, "jpeg")

    def test_thumbnail_generation(self):
        _, thumb, _, _ = make_variants(image_bytes((500, 500)))
        with Image.open(io.BytesIO(thumb)) as im:
            self.assertEqual(im.size, (200, 200))

    def test_transparency_preserved(self):
        resized, _, mime, ext = make_variants(image_bytes((300, 200), "PNG", "RGBA"))
        self.assertEqual(mime, "image/png")
        self.assertEqual(ext, "png")
        with Image.open(io.BytesIO(resized)) as im:
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
        event = {
            "source": "aws.s3",
            "detail-type": "Object Created",
            "detail": {
                "bucket": {"name": "cloudpix-test"},
                "object": {"key": "originals/abc-123.jpg"},
            },
        }
        self.assertEqual(
            extract_created_objects(event),
            [("cloudpix-test", "originals/abc-123.jpg")],
        )

    def test_ignore_non_object_created_eventbridge_event(self):
        event = {
            "source": "aws.s3",
            "detail-type": "Object Deleted",
            "detail": {
                "bucket": {"name": "cloudpix-test"},
                "object": {"key": "originals/abc-123.jpg"},
            },
        }
        self.assertEqual(extract_created_objects(event), [])

    def test_extract_legacy_s3_event(self):
        event = {
            "Records": [{
                "eventSource": "aws:s3",
                "s3": {
                    "bucket": {"name": "cloudpix-test"},
                    "object": {"key": "originals%2Fabc-123.jpg"},
                },
            }]
        }
        self.assertEqual(
            extract_created_objects(event),
            [("cloudpix-test", "originals/abc-123.jpg")],
        )


if __name__ == "__main__":
    unittest.main()

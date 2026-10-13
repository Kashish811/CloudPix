from pathlib import Path
import re
import unittest


TEMPLATE = Path(__file__).resolve().parents[1] / "template.yaml"


class TemplateContractTests(unittest.TestCase):
    def test_api_is_unauthenticated_and_has_the_existing_routes(self):
        content = TEMPLATE.read_text(encoding="utf-8")
        api = re.search(r"(?ms)^  CloudPixApi:\n(?P<body>.*?)(?=^  UploadHandler:)", content)
        self.assertIsNotNone(api)
        self.assertNotIn("DefaultAuthorizer", api.group("body"))
        self.assertNotIn("Cognito", content)

        for path, method in (("/uploads", "post"), ("/history", "get"), ("/images/{image_id}", "get")):
            with self.subTest(path=path, method=method):
                self.assertRegex(content, rf"(?s)Path: {re.escape(path)}\s+Method: {method}")

    def test_delete_route_cors_and_scoped_permission_are_configured(self):
        content = TEMPLATE.read_text(encoding="utf-8")
        self.assertRegex(content, r"(?s)Path: /images/\{image_id\}\s+Method: delete")
        cors = re.search(r"(?ms)^      Cors:\n(?P<body>.*?)(?=^  UploadHandler:)", content)
        self.assertIsNotNone(cors)
        self.assertIn("GET,POST,DELETE,OPTIONS", cors.group("body"))
        handler = re.search(r"(?ms)^  UploadHandler:\n(?P<body>.*?)(?=^  ImageProcessor:)", content)
        self.assertIsNotNone(handler)
        self.assertIn("Action: s3:DeleteObject", handler.group("body"))
        self.assertIn("Resource: !Sub '${ImagesBucket.Arn}/*'", handler.group("body"))
        self.assertIn("S3WritePolicy", handler.group("body"))
        self.assertIn("S3ReadPolicy", handler.group("body"))
        self.assertNotIn("S3CrudPolicy", handler.group("body"))

    def test_existing_s3_cors_and_resource_naming_are_preserved(self):
        content = TEMPLATE.read_text(encoding="utf-8")
        bucket = re.search(r"(?ms)^  ImagesBucket:\n(?P<body>.*?)(?=^  ImagesTable:)", content)
        self.assertIsNotNone(bucket)
        self.assertIn("AllowedOrigins: [!Ref AllowedOrigin]", bucket.group("body"))
        self.assertIn("AllowedMethods: [PUT, GET, HEAD]", bucket.group("body"))
        self.assertIn("ImagesTable", content)


if __name__ == "__main__":
    unittest.main()

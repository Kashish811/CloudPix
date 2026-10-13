import unittest
from pathlib import Path

from security.cspm_check import analyze_template, render


TEMPLATE = Path(__file__).resolve().parents[1] / "template.yaml"


class CspmCheckerTests(unittest.TestCase):
    def test_current_template_reports_static_controls_and_unresolved_or_disabled_settings(self):
        checks = analyze_template(TEMPLATE.read_text(encoding="utf-8"))
        results = {check.name: check for check in checks}

        self.assertEqual(results["S3 public-access protections"].status, "PASS")
        self.assertEqual(results["S3 default encryption"].status, "PASS")
        self.assertEqual(results["API Gateway authentication"].status, "FAIL")
        self.assertIn("API routes are unauthenticated", results["API Gateway authentication"].detail)
        self.assertEqual(results["API Gateway CORS"].status, "REVIEW")
        self.assertEqual(results["S3 bucket CORS"].status, "REVIEW")
        self.assertEqual(results["DynamoDB point-in-time recovery"].status, "FAIL")
        self.assertIn("deployment origin is not verified", results["API Gateway CORS"].detail)

    def test_missing_public_access_and_encryption_are_failures(self):
        template = """Resources:
  ImagesBucket:
    Type: AWS::S3::Bucket
    Properties:
      CorsConfiguration:
        CorsRules:
          - AllowedOrigins: ['https://example.test']
            AllowedMethods: [GET]
  ImagesTable:
    Type: AWS::DynamoDB::Table
    Properties:
      PointInTimeRecoverySpecification:
        PointInTimeRecoveryEnabled: true
  CloudPixApi:
    Type: AWS::Serverless::Api
    Properties:
      Auth:
        DefaultAuthorizer: UserPoolAuth
        AddDefaultAuthorizerToCorsPreflight: false
        Authorizers:
          UserPoolAuth:
            UserPoolArn: !GetAtt Pool.Arn
      Cors:
        AllowOrigin: 'https://example.test'
        AllowMethods: 'GET,POST,OPTIONS'
        AllowHeaders: 'Content-Type,Authorization'
"""
        results = {check.name: check for check in analyze_template(template)}
        self.assertEqual(results["S3 public-access protections"].status, "FAIL")
        self.assertEqual(results["S3 default encryption"].status, "FAIL")

    def test_dynamic_protection_values_are_review_not_pass(self):
        template = """Resources:
  ImagesBucket:
    Type: AWS::S3::Bucket
    Properties:
      PublicAccessBlockConfiguration:
        BlockPublicAcls: !Ref BlockAcls
        IgnorePublicAcls: true
        BlockPublicPolicy: true
        RestrictPublicBuckets: true
      BucketEncryption:
        ServerSideEncryptionConfiguration:
          - ServerSideEncryptionByDefault:
              SSEAlgorithm: !Ref EncryptionAlgorithm
      CorsConfiguration:
        CorsRules:
          - AllowedOrigins: ['https://example.test']
            AllowedMethods: [GET]
  ImagesTable:
    Type: AWS::DynamoDB::Table
    Properties:
      PointInTimeRecoverySpecification:
        PointInTimeRecoveryEnabled: true
  CloudPixApi:
    Type: AWS::Serverless::Api
    Properties:
      Auth:
        DefaultAuthorizer: UserPoolAuth
        AddDefaultAuthorizerToCorsPreflight: false
        Authorizers:
          UserPoolAuth:
            UserPoolArn: !GetAtt Pool.Arn
      Cors:
        AllowOrigin: 'https://example.test'
        AllowMethods: 'GET,POST,OPTIONS'
        AllowHeaders: 'Content-Type,Authorization'
"""
        results = {check.name: check for check in analyze_template(template)}
        self.assertEqual(results["S3 public-access protections"].status, "REVIEW")
        self.assertEqual(results["S3 default encryption"].status, "REVIEW")

    def test_render_includes_statuses_and_summary(self):
        output = render(analyze_template(TEMPLATE.read_text(encoding="utf-8")))
        self.assertIn("static template review only", output)
        self.assertIn("Summary:", output)
        self.assertIn("PASS:", output)
        self.assertIn("FAIL:", output)
        self.assertIn("REVIEW:", output)
        self.assertIn("Remediation:", output)
        self.assertIn("Add and test an API authorizer", output)

    def test_missing_resources_reports_each_check_as_failed(self):
        checks = analyze_template("Description: no resources\n")
        self.assertEqual(len(checks), 6)
        self.assertTrue(all(check.status == "FAIL" for check in checks))


if __name__ == "__main__":
    unittest.main()

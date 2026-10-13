# Static CSPM demonstration

Run the dependency-free checker from the project root:

```bash
python security/cspm_check.py
python -m unittest tests.test_cspm_check -v
```

You can pass a different SAM/CloudFormation template as the first argument:

```bash
python security/cspm_check.py path/to/template.yaml
```

The checker reads template text only. It does not call AWS, inspect deployed resources, or establish whether live settings match the file.

- **PASS** means the checked value is explicitly present and meets this check in the template.
- **FAIL** means a required setting is missing or explicitly disabled/unsafe for this check.
- **REVIEW** means a parameter, intrinsic expression, wildcard, or unsupported form prevents a static conclusion. Confirm its resolved value and the deployed setting separately.

The checks cover S3 public-access-block flags, default encryption, bucket CORS, API default authorizer and generated preflight behavior, API CORS, and DynamoDB point-in-time recovery. The dependency-free parser is tailored to this project's simple YAML structure; YAML aliases, anchors, or unusual formatting may not be interpreted correctly. The checks are intentionally narrow and do not replace a full CloudFormation/IaC scanner or a live AWS security review. A nonzero exit status means at least one check failed; an unreadable template returns a separate nonzero status.

With the current template, S3 access blocking and AES256 encryption are statically configured. API Gateway has no authorizer, so the API authentication check reports FAIL. The configured CORS origin requires review at deployment, and DynamoDB point-in-time recovery is explicitly disabled.

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

## College presentation walkthrough

From the project root, run:

```bash
python security/cspm_check.py
```

Explain the output as a **static review of the checked-in template**, not an AWS account scan:

1. Show the PASS, FAIL, and REVIEW totals and read the explanation and remediation shown under each finding.
2. PASS means the control is explicitly represented in the template. It is not evidence that the deployed resource has the same setting.
3. FAIL identifies a missing or explicitly disabled control; use the printed remediation as the proposed follow-up.
4. REVIEW means a parameter, intrinsic expression, or deployment-time value needs human verification.
5. In this project, API Gateway authentication is a known FAIL: the API is intentionally unauthenticated. CORS is not authorization. A caller who can reach the API can read shared history/status, request uploads, and delete an image if its ID is known. The Delete UI confirmation only helps prevent accidental clicks; it does not secure the API.

Use `python -m unittest tests.test_cspm_check -v` to demonstrate the local checker tests. The checker exits nonzero while a FAIL finding exists; that is an expected report outcome for the current unauthenticated API and disabled point-in-time recovery, not a passing security assessment. For any live AWS conclusion, separately inspect the actual account and deployed stack using approved read-only access; this checker never performs that inspection.

# CloudPix Setup and Deployment

## Prerequisites

- Python 3.12
- AWS CLI v2, configured with a deployment identity (`aws configure` or your organization's SSO)
- AWS SAM CLI
- An AWS account where you are authorized to create IAM, Lambda, API Gateway, S3, DynamoDB, and CloudFormation resources

Do not put access keys in this repository or in frontend code.

## 1. Install and test locally

From the project root:

```bash
python -m venv .venv
# Windows PowerShell:
.venv\Scripts\Activate.ps1
# macOS/Linux:
# source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
```

These unit tests exercise the real Pillow image transformation function locally. They do not require AWS credentials.

## 2. Validate the SAM template

```bash
sam validate --lint
sam build
```

If SAM reports a schema issue, fix it before deployment. Confirm your AWS CLI identity and region:

```bash
aws sts get-caller-identity
aws configure get region
```

The provided `samconfig.toml` defaults to `ap-south-1` (Mumbai). Change it if your class/account uses another region.

## 3. Deploy

From the project root:

```bash
sam deploy --guided
```

Suggested values:
- Stack Name: `cloudpix`
- AWS Region: `ap-south-1` (or a region you use)
- Confirm changes before deploy: `Y`
- Allow SAM CLI IAM role creation: `Y`
- Save arguments to configuration: `Y`

For the simplest classroom demo, `AllowedOrigin=*` allows browser requests from any origin. For a hosted frontend, deploy with the exact origin, e.g. `https://your-user.github.io` (do not include a path). You can re-run `sam deploy --parameter-overrides AllowedOrigin=https://your-user.github.io` after reviewing your SAM configuration. If the bucket CORS configuration changes, the stack update applies it.

When deployment completes, note the `ApiBaseUrl`, `ImagesBucketName`, and `ImagesTableName` outputs. The API base URL should end with `/prod`.

## 4. Open the frontend

For local development, serve the static files from a local web server rather than opening the HTML as `file://`:

```bash
python -m http.server 8080 --directory frontend
```

Open `http://localhost:8080`. Click the **AWS serverless** badge at the top right and paste the `ApiBaseUrl` output. This value is stored in local browser storage.

For a public link, host the `frontend/` directory using GitHub Pages or an S3 static website/CDN setup. If you choose GitHub Pages, configure `AllowedOrigin` to your exact published origin and redeploy. The API is unauthenticated, so do not treat it as a production service.

## 5. Upload and verify

1. Select a small JPG or PNG (under 10 MB).
2. Click **Upload & process**.
3. The browser calls API Gateway for a short-lived presigned URL.
4. The browser PUTs the original to `originals/<UUID>.<ext>` in S3.
5. S3 sends an object-created event to EventBridge, which invokes `ImageProcessor`.
6. Lambda writes `processed/<UUID>/resized.*` and `thumbnail.*`.
7. DynamoDB status changes from Pending to Processing to Completed (or Failed).
8. The dashboard polls status and displays the signed output links.

See `TESTING.md` for checks in AWS Console and CLI.

## Important implementation note

S3 event delivery to EventBridge is enabled on the bucket, and the SAM `EventBridgeRule` filters `Object Created` events to the `originals/` prefix. This avoids a common circular dependency between an S3 bucket notification and a Lambda function in a single CloudFormation stack. The processor writes only to `processed/`, and the event handler also ignores any key outside `originals/`. The handler parses the EventBridge `detail.bucket.name` and `detail.object.key` fields (and supports legacy S3 records for local compatibility). Do not add a second rule that triggers on all prefixes. The API Lambda has both S3 read and write permissions because it creates presigned upload and download URLs; the bucket remains private.

## Troubleshooting

- **CORS error on API request:** ensure `AllowedOrigin` matches the page origin and redeploy. For local UI use `http://localhost:8080`.
- **CORS error on S3 PUT:** check the bucket's CORS rules allow PUT from the exact page origin. The SAM template sets the same `AllowedOrigin`.
- **403 on presigned PUT:** ensure the `Content-Type` header exactly matches the one used to request the URL and the URL has not expired.
- **Status remains Pending:** confirm S3 EventBridge event delivery is enabled, check the EventBridge rule and the `ImageProcessor` Lambda's CloudWatch logs.
- **Failed status:** open the processor log group and inspect the logged exception. The dashboard does not expose a stack trace.
- **SAM deploy errors:** check IAM permissions and `sam validate --lint`; use the full deployment output to identify the resource that failed.

## Delete resources after evaluation

Review the stack and data first. Then:

```bash
aws cloudformation delete-stack --stack-name cloudpix --region ap-south-1
```

The S3 bucket may contain objects and CloudFormation can fail to delete a non-empty bucket. If that happens, first empty the bucket shown in `ImagesBucketName` in the S3 console, then repeat the stack deletion. Also remove any separately hosted frontend resources if you created them. Confirm the stack is deleted in CloudFormation. Data in the bucket/table will be removed when their resources are deleted; download anything you need before cleanup.

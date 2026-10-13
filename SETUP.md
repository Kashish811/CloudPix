# CloudPix Setup

This project has an unauthenticated API. Use only disposable images and a controlled test environment. The API history is shared by anyone who can reach its endpoint. Do not use sensitive images or present this configuration as production-ready.

## Local-only checks

From the repository root:

```bash
python -m unittest discover -s tests -v
python security/cspm_check.py
```

The CSPM checker reads `template.yaml` only; it does not inspect AWS. Its API authentication check should report **FAIL** because this version intentionally has no authorizer. `sam validate --lint` is a local validation command if SAM CLI is installed. Do not run `sam build` in this checkout unless using a separate build output directory; existing `.aws-sam` content is preserved.

## Isolated test-stack preparation (future use)

Do not deploy from the existing `samconfig.toml`. It may contain production stack defaults. Use a unique test stack name, a separate temporary SAM config and build directory, and verify the target account before preparing a change set.

### Record and verify the target (AWS read-only checks)

Before continuing, record an expected **nonproduction** AWS account ID, region, profile, and unique stack name. Replace all placeholders. Stop if any verification command fails or does not match the recorded values.

```powershell
$testProfile = "replace-with-test-profile"
$expectedAccountId = "replace-with-expected-nonproduction-account-id"
$testRegion = "replace-with-test-region"
$testStackName = "cloudpix-security-test-replace-with-unique-suffix"

$actualAccountId = aws sts get-caller-identity --profile $testProfile --region $testRegion --query Account --output text
if ($LASTEXITCODE -ne 0 -or $actualAccountId.Trim() -ne $expectedAccountId) { throw "Identity check failed or account mismatch; stop." }

$profileRegion = aws configure get region --profile $testProfile
if ($LASTEXITCODE -ne 0 -or $profileRegion.Trim() -ne $testRegion) { throw "Profile region check failed or region mismatch; stop." }

$matchingStacks = aws cloudformation list-stacks --region $testRegion --profile $testProfile --query "StackSummaries[?StackName=='$testStackName'].StackName" --output text
if ($LASTEXITCODE -ne 0) { throw "Could not verify stack-name availability; stop." }
if (-not [string]::IsNullOrWhiteSpace($matchingStacks) -and $matchingStacks.Trim() -ne "None") { throw "Stack already exists; choose a new name." }
```

The STS identity and CloudFormation stack queries contact AWS but are read-only. The profile-region command reads local CLI configuration. A human must confirm the account is nonproduction and the region, profile, and unused stack name are intended. The current template has no Cognito domain or authentication callback parameters.

### Local-only build/config preparation (not run automatically)

Use a fresh temporary directory that does not already exist. These commands are local and do not create AWS resources. SAM configuration is written outside the repository; do not overwrite `samconfig.toml` or existing `.aws-sam` directories.

```powershell
$testRoot = Join-Path $env:TEMP "cloudpix-security-test-replace-with-unique-suffix"
if (Test-Path -LiteralPath $testRoot) { throw "Choose a new temporary directory; this path already exists." }
New-Item -ItemType Directory -Path $testRoot | Out-Null
$buildDir = Join-Path $testRoot "build"
$testSamConfig = Join-Path $testRoot "samconfig.test.toml"

sam build --template-file template.yaml --build-dir $buildDir

@"
version = 0.1
[default.deploy.parameters]
stack_name = "$testStackName"
region = "$testRegion"
profile = "$testProfile"
capabilities = "CAPABILITY_IAM"
confirm_changeset = true
"@ | Set-Content -LiteralPath $testSamConfig -Encoding ascii
```

The test stack creates its own generated S3 bucket and DynamoDB table because the template does not set fixed physical names or import production resources. Pass the local frontend origin explicitly as `AllowedOrigin`; this controls both API CORS and the new test bucket's CORS. It does not change production CORS.

### Pending change-set preparation (contacts AWS; does not execute changes)

After reviewing the account, region, profile, and stack name, a human may prepare a pending change set. `sam deploy --no-execute-changeset` contacts AWS and can upload artifacts or use/create a SAM deployment-artifact bucket; it is not read-only. Use only the explicit test stack/config values:

```powershell
sam deploy `
  --template-file (Join-Path $buildDir "template.yaml") `
  --config-file $testSamConfig `
  --stack-name $testStackName `
  --region $testRegion `
  --profile $testProfile `
  --parameter-overrides "ParameterKey=AllowedOrigin,ParameterValue=http://localhost:8080" `
  --no-execute-changeset
```

### Change-set review and execution

Review the pending change set with a read-only CloudFormation query using the exact test stack, change-set name, profile, and region:

```powershell
aws cloudformation describe-change-set --stack-name $testStackName --change-set-name "replace-with-change-set-name" --region $testRegion --profile $testProfile
```

Confirm the account and region, unique test stack name, newly generated bucket/table, local CORS origin, and absence of production references, imports, fixed resource names, replacements, deletions, or unexpected permissions. Do not execute the change set until it has been reviewed and separately approved. Executing it requires `aws cloudformation execute-change-set` against that exact test stack and change-set name; that command changes infrastructure. Never use the production `cloudpix` stack name or values from production `samconfig.toml` for this test.

## Run the frontend locally

```bash
python -m http.server 8080 --directory frontend
```

Open `http://localhost:8080`, click the AWS serverless configuration button, and enter the test stack's `ApiBaseUrl`. The browser stores the URL in local storage. The refreshed UI supports multiple uploads, image-history views, status polling, previews, and downloads.

## Upload and processing flow

1. The browser requests a short-lived presigned upload URL from `POST /uploads`.
2. The browser uploads the original object to S3 using HTTP PUT.
3. S3 emits an Object Created event through EventBridge for the `originals/` prefix.
4. The image processor validates the bytes and writes resized and thumbnail variants under `processed/`.
5. DynamoDB stores status and image metadata; the frontend polls `/images/{image_id}` and retrieves `/history`.

`AllowedOrigin` also controls the S3 bucket CORS value in the template. Preserve the deployed production value; a repository value is not proof of the live setting. No production deployment or live configuration is verified here.

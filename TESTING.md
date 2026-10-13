# CloudPix — Testing Guide

This document describes how to test CloudPix locally, validate its API, verify automatic image processing on AWS, and check common error scenarios.

Testing is divided into two categories:

1. **Local testing:** Tests image-processing logic and selected backend behavior without deploying AWS resources.
2. **AWS integration testing:** Verifies that the deployed frontend, API Gateway, Lambda functions, S3 bucket, and DynamoDB table work together.

Passing local tests does not guarantee that the complete application works in AWS. Both types of testing should be completed before claiming that the deployed application has been verified.

---

## 1. Prerequisites

For local testing, install:

- Python 3.12
- The project's Python dependencies
- Git
- A modern web browser

For AWS integration testing, also configure:

- AWS CLI
- AWS SAM CLI
- An AWS account with permission to deploy and inspect the required resources

Use a test AWS account or an isolated project stack wherever possible.

---

## 2. Install Dependencies

Open a terminal in the CloudPix project root.

Install the dependencies:

```bash
python -m pip install -r requirements.txt
```

Confirm that Python is available:

```bash
python --version
```

Use Python 3.12 for consistency with the project's Lambda runtime.

---

## 3. Run the Automated Unit Tests

Run:

```bash
python -m unittest discover -s tests -v
```

This command discovers and executes the Python unit tests under the `tests/` directory.

The `-v` option displays individual test names and their results.

### Expected Result

Successful tests should be marked `ok`, followed by a final summary showing the number of tests run and whether any failures or errors occurred.

For example, a successful test run ends with output similar to:

```text
Ran 9 tests in X.XXXs

OK
```

The number of tests may change as the project evolves. Treat this as an illustrative output, not a guarantee of the current test count.

If a test fails, inspect the traceback and resolve the issue before relying on the result.

### Test Coverage

The included tests cover the following areas:

| Test Area | What Is Checked |
|---|---|
| JPEG processing | A valid JPEG can be processed |
| Aspect ratio | Resizing preserves the image's aspect ratio |
| Thumbnail generation | The thumbnail respects the configured maximum dimensions |
| PNG transparency | Transparency is preserved when processing PNG images |
| Unsupported formats | Unsupported image formats are rejected |
| Corrupt image data | Invalid image contents are rejected |
| File-size validation | Inputs exceeding the configured 10 MB limit are rejected |
| Event parsing | Supported S3 Object Created event structures are parsed |
| Event filtering | Unsupported EventBridge event types are rejected |
| Legacy event compatibility | Legacy S3 notification events are handled |
| Image metadata | Output dimensions and byte sizes are returned by image processing |
| Download URL handling | Presigned download URLs and original-size aliases are handled |
| Delete endpoint | Selected deletion behavior is tested, including missing-image handling |

The exact coverage depends on the tests currently present in the repository. A test listed above should be considered covered only if the corresponding test exists and passes in the current version.

### Does Local Testing Require AWS?

No. The included unit tests are intended to run locally without deploying AWS resources.

However, they do not reproduce every behavior of API Gateway, S3 event delivery, IAM permissions, DynamoDB, or the complete deployed application.

---

## 4. Validate and Build the AWS SAM Template

These commands validate and prepare the infrastructure configuration. They do not deploy the application.

### Validate the Template

```bash
sam validate --lint
```

A successful validation indicates that SAM can validate the template. It does not establish that every AWS resource can be created successfully in the selected account.

### Build the Application

```bash
sam build
```

This prepares the application and its dependencies for deployment.

The build process does not, by itself, create the live application in AWS.

---

## 5. Deploy Before Running AWS Integration Tests

If the project has not been deployed yet, follow the deployment instructions in `SETUP.md`.

The guided deployment command is:

```bash
sam deploy --guided
```

After deployment, identify the following stack outputs:

- `ApiBaseUrl`
- `ImagesBucketName`
- `ImagesTableName`

Use the actual values returned by your deployed stack.

Do not invent an API ID, bucket name, or table name.

---

## 6. Test the API

After deployment, set the API base URL.

Replace the example URL with the actual `ApiBaseUrl` output from the deployed stack.

```bash
API_BASE='https://YOUR_API_ID.execute-api.ap-south-1.amazonaws.com/prod'
```

The example above is a template. The real URL and Region must match your deployment.

### Test 6.1: Retrieve Image History

Run:

```bash
curl -i "$API_BASE/history"
```

Check the HTTP status and response body.

A successful request should return a valid response containing the history data in the format implemented by the API.

An empty history is possible when no images have been uploaded.

### Test 6.2: Request an Upload URL

Run:

```bash
curl -i -X POST "$API_BASE/uploads" \
  -H 'Content-Type: application/json' \
  -d '{"filename":"sample.jpg","content_type":"image/jpeg","size":12345}'
```

This example demonstrates the request format.

The declared size must match the actual size of the file you upload. For an end-to-end test, use the frontend or replace the example size with the real file size.

A successful request should return the upload information, including a presigned URL.

### Test 6.3: Upload a Real Image

Using the upload URL returned by the previous request, upload an actual image file:

```bash
curl -i -X PUT 'PASTE_PRESIGNED_UPLOAD_URL' \
  -H 'Content-Type: image/jpeg' \
  --data-binary @sample.jpg
```

Replace `PASTE_PRESIGNED_UPLOAD_URL` with the complete URL returned by the API.

Ensure that:

- `sample.jpg` exists in the current directory.
- The file is a valid JPEG.
- The content type matches the one used to request the upload URL.
- The declared file size matches the actual file size.

Presigned URLs are temporary. Request a new URL if the previous one has expired.

---

## 7. Verify Automatic S3-to-Lambda Processing

This test verifies the main purpose of CloudPix: automatically processing an image after it is uploaded.

### Step 1: Upload an Image

Open the CloudPix dashboard, configure the API base URL, and upload a valid JPEG or PNG image.

Wait for the upload to finish.

### Step 2: Check Amazon S3

Open the S3 bucket identified by the `ImagesBucketName` stack output.

Verify that the original image has been stored under:

```text
originals/
```

The object key will normally contain a generated identifier rather than the original filename.

### Step 3: Check the Image Processor Lambda

Open the AWS Lambda console.

Select the deployed image processor function, named `ImageProcessor` if the stack uses that logical resource name.

Open:

**Monitor → View CloudWatch logs**

Find the log stream corresponding to the image upload and inspect the processing messages.

A successful invocation should indicate that the image was processed.

### Step 4: Verify the Processed Images

Return to the S3 bucket.

For a JPEG input, verify the existence of the generated objects under the relevant `processed/` prefix. The expected filenames are typically:

```text
processed/<IMAGE_ID>/resized.jpeg
processed/<IMAGE_ID>/thumbnail.jpeg
```

The exact image identifier and output extension depend on the uploaded image and the implementation.

For PNG inputs, verify the corresponding PNG outputs.

### Step 5: Verify DynamoDB

Open the DynamoDB table identified by the `ImagesTableName` stack output.

Find the record corresponding to the uploaded image.

After successful processing, the record should indicate a completed state and contain the relevant processed object keys and metadata supported by the implementation.

Fields may include:

- Image identifier
- Original object key
- Processing status
- Resized image key
- Thumbnail key
- Original and output dimensions
- Original and output byte sizes
- Processing timestamp

The exact field names depend on the backend implementation.

### Step 6: Verify the Dashboard

Return to the CloudPix dashboard and refresh the history.

Verify that:

- The uploaded image appears in history.
- Its status eventually changes to `Completed`.
- The available output variants are displayed.
- The download controls work for the available images.
- Displayed dimensions and file sizes match the data returned by the API, where supported by the frontend.

If the status remains `Pending` or `Processing`, inspect the processor's CloudWatch logs and the DynamoDB record before concluding that processing succeeded.

---

## 8. Error-Handling Tests

Perform these tests using disposable test files and records.

### Test 8.1: Unsupported File Type

Attempt to upload a `.txt` file or another unsupported format through the dashboard.

Expected result:

- The frontend should reject the file before uploading it.

Also test backend validation with an unsupported content type.

Expected result:

- The API should reject the unsupported request, normally with HTTP 400.

The frontend and backend checks are separate. Passing one does not prove that the other works.

### Test 8.2: Oversized Image

Attempt to select an image larger than 10 MB.

Expected result:

- The frontend should reject the file.

The backend image processor should also validate the actual uploaded image data rather than relying exclusively on the filename or declared content type.

### Test 8.3: Corrupt Image Data

Use a disposable test file containing invalid image bytes.

Request an upload URL using a supported image MIME type, upload the invalid bytes using the required content type, and inspect the resulting record.

Expected result:

- The processor rejects the invalid image.
- The failure is recorded in the processing status where supported by the implementation.
- CloudWatch contains useful diagnostic information.

Do not use an important image for this test.

### Test 8.4: Missing S3 Object

A missing-object test requires a valid test record and a controlled event referring to a nonexistent S3 object.

Expected result:

- The processor handles the missing object without silently reporting success.
- The failure is recorded where supported by the implementation.
- CloudWatch logs provide information that can help diagnose the problem.

Perform this test only if you understand the relationship between the test event, the object key, and the DynamoDB record.

### Test 8.5: Repeated S3 Events

S3 event notifications can be delivered more than once.

Using a controlled test event, verify whether processing an already-completed image is safely handled by the current implementation.

Inspect CloudWatch logs and DynamoDB to determine whether the processor skips repeated work or handles it safely.

Do not assume duplicate-event protection works unless the deployed behavior has been verified.

---

## 9. Verify Image Downloads

After uploading an image and waiting for processing to finish:

1. Open the image in the dashboard.
2. Download the original image.
3. Download the resized image.
4. Download the thumbnail.
5. Open the downloaded files locally and verify that they are valid images.
6. Confirm that each download contains the expected image variant.

The exact variants available depend on the image's processing status.

### If a Download Fails

Check the following:

- The presigned URL has not expired.
- The object still exists in S3.
- The frontend is using the correct API base URL.
- The S3 bucket's CORS configuration permits the required browser request from the frontend origin.
- The response from S3 is not being blocked by a browser security policy.
- The frontend download implementation handles the returned URL correctly.

If the browser can open an image but cannot download it as a file, inspect the frontend's download logic and browser console.

---

## 10. Verify Image Deletion

**Warning:** Deletion removes data. Use an image created specifically for testing.

First retrieve the history:

```bash
curl -i "$API_BASE/history"
```

Choose a test image ID from the returned records.

Run:

```bash
curl -i -X DELETE "$API_BASE/images/IMAGE_ID"
```

Replace `IMAGE_ID` with the actual identifier of the test image.

After a successful deletion, verify that:

1. The API reports a successful deletion.
2. The DynamoDB record is no longer present.
3. The original S3 object is removed.
4. The processed variants are removed.
5. A subsequent request for the deleted record returns the expected missing-record response, normally HTTP 404.

If any object or record remains, inspect the API response, Lambda logs, IAM permissions, and the stored object keys.

Do not run this test against images you need to keep.

---

## 11. Verify CORS

CORS must allow the deployed frontend to make the required API requests.

For browser-based testing:

1. Open the frontend.
2. Open the browser developer tools.
3. Select the Network tab.
4. Perform an upload or history request.
5. Inspect the request and response.
6. Check for CORS errors in the console.

Where supported by the API configuration, an OPTIONS request can also be inspected:

```bash
curl -i -X OPTIONS "$API_BASE/history"
```

Verify that the returned CORS headers match the actual API configuration and permit the methods and headers required by the frontend.

A successful `curl` request alone does not prove that a browser request will pass CORS checks.

---

## 12. GitHub Actions Testing

If the repository's GitHub Actions workflow is configured, pushing a commit or opening a pull request that matches its triggers should start the automated checks.

To verify the workflow:

1. Open the CloudPix GitHub repository.
2. Select the **Actions** tab.
3. Open the most recent workflow run.
4. Inspect the test and validation steps.
5. Confirm that the run completed successfully.

A successful workflow demonstrates only that the configured checks passed in that workflow environment. It does not prove that the application was deployed to AWS or that live image processing succeeded.

---

## 13. Test Results Record

Use this table to record actual results during project evaluation.

| Test | Expected Result | Actual Result |
|---|---|---|
| Local unit tests | All included tests pass | To be recorded |
| SAM template validation | Template validates successfully | To be recorded |
| SAM build | Application build completes | To be recorded |
| Upload API | Returns upload information | To be recorded |
| S3 upload | Original image is stored | To be recorded |
| Automatic Lambda trigger | Processor is invoked | To be recorded |
| Image resizing | Resized output is generated | To be recorded |
| Thumbnail generation | Thumbnail output is generated | To be recorded |
| DynamoDB update | Processing record is updated | To be recorded |
| Image history | Uploaded image appears in history | To be recorded |
| Image download | Expected image variant downloads | To be recorded |
| Image deletion | Test image and record are removed | To be recorded |
| Error handling | Invalid input is rejected or marked failed | To be recorded |

Replace `To be recorded` with the result you actually observe. Do not mark a test as passed without executing it.

---

## 14. Testing Limitations

Local unit tests do not fully simulate:

- API Gateway routing and configuration.
- Live S3 event delivery.
- Actual Lambda execution permissions.
- DynamoDB behavior in AWS.
- CloudWatch logging in the deployed environment.
- Browser CORS behavior against the deployed endpoints.
- Full upload-to-processing-to-download integration.

These behaviors require AWS integration testing.

The test suite should also not be treated as proof of production readiness. The current project is intended as an academic demonstration and requires additional authentication, authorization, operational controls, and security review before public or production use.

## 15. Cleanup After Testing

To minimize unnecessary AWS charges:

1. Delete disposable test images that are no longer needed.
2. Review the S3 bucket for leftover original and processed objects.
3. Review CloudWatch log retention and stored logs.
4. Confirm that no other resources are required before deleting the stack.
5. Follow the cleanup procedure in `SETUP.md` to delete the CloudFormation stack when the project is no longer needed.
6. Verify the stack deletion and check the AWS console for resources that may remain.

Check the actual resources and current AWS billing information rather than assuming that all services are free.

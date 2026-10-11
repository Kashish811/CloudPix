# CloudPix Testing Guide

## Local tests

Run:

```bash
python -m unittest discover -s tests -v
```

Covered by the included tests:
- Valid JPEG processing and aspect-ratio preservation.
- Thumbnail dimension limit.
- PNG transparency preservation.
- Unsupported image format rejection.
- Corrupt data rejection.
- Input larger than 10 MB rejection.
- EventBridge S3 Object Created event parsing.
- Non-Object-Created EventBridge event rejection.
- Legacy S3 notification event parsing for compatibility.

These tests call the actual `make_variants` image-processing function. They do not require AWS.

## API validation after deployment

Set your API base URL from the SAM `ApiBaseUrl` output:

```bash
API_BASE='https://YOUR_API_ID.execute-api.ap-south-1.amazonaws.com/prod'
curl -i "$API_BASE/history"
curl -i -X POST "$API_BASE/uploads" \
  -H 'Content-Type: application/json' \
  -d '{"filename":"sample.jpg","content_type":"image/jpeg","size":12345}'
```

The POST response contains an upload URL. Use a real file and exact content type for an end-to-end test:

```bash
curl -i -X PUT 'PASTE_PRESIGNED_UPLOAD_URL' \
  -H 'Content-Type: image/jpeg' \
  --data-binary @sample.jpg
```

The size in the JSON request must match the actual file size. The backend checks the declared size before issuing the URL, while the processor independently checks the bytes and decoded image. For a normal upload, use the frontend, which sends the real file size.

## Verify automatic S3 → Lambda processing

1. Open the S3 bucket named in `ImagesBucketName`.
2. Confirm the uploaded object exists under `originals/`.
3. Open Lambda and select `ImageProcessor`.
4. Open **Monitor → View CloudWatch logs**. Find a log line similar to `Processed image <UUID>`.
5. In S3, verify `processed/<UUID>/resized.jpeg` and `processed/<UUID>/thumbnail.jpeg` (PNG originals produce PNG variants).
6. In DynamoDB, open the `ImagesTableName` table and inspect the record. `status` should be `Completed`, with `resized_key`, `thumbnail_key`, and `processed_at`.
7. Refresh the CloudPix dashboard. It should show the output links and completed status.

## Error-path checks

- Try a `.txt` or unsupported file in the UI: client-side validation should reject it.
- Try a file larger than 10 MB: client-side validation should reject it.
- For backend validation, invoke the API with an unsupported `content_type`; expect HTTP 400.
- For corrupt image data, request a presigned upload URL using a supported MIME type, upload non-image bytes with the exact Content-Type, and confirm the record transitions to Failed. The processor validates the actual contents.
- Repeat a successful S3 event after the item is Completed: the processor skips reprocessing. Do not manually alter a real event unless you understand the test record/key relationship.
- To test a missing S3 object, invoke the Lambda with an event key that does not exist but corresponds to a valid metadata record. The status should become Failed; inspect CloudWatch logs.

## What is not covered by automated unit tests

The tests do not emulate DynamoDB, API Gateway, S3 notifications, IAM, or live AWS. Duplicate-event handling, IAM access, CORS, status updates, and full upload-to-processing must be verified after deployment. No AWS deployment or live test is claimed by this repository.

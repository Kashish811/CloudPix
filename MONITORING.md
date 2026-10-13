# CloudPix CloudWatch demonstration

This guide demonstrates the existing asynchronous image-processing Lambda using CloudWatch metrics and logs. It does not add infrastructure, and no measurements are included here: record only values observed in the AWS console for the selected account, function, and time range.

## Before the demonstration

- Identify the intended stack, AWS account, region, and deployed `ImageProcessor` Lambda. Do not assume a function name from the logical SAM name; use the deployed function associated with the intended stack.
- Use a controlled environment and disposable, small images. The API is unauthenticated, and knowing an image ID may allow deletion. Do not use sensitive data or perform the demo against production without explicit approval.
- Record the test start time and the exact function name. Choose a short, fixed CloudWatch time window that includes the test and compare it with a similarly sized idle window if useful.

## Observe Lambda metrics

In the AWS console, open **Lambda**, select the deployed image processor, then open **Monitor** and its CloudWatch metrics view. Select the same function and time window throughout the demonstration. View the `AWS/Lambda` metrics:

| Metric | Statistic to show | What it demonstrates |
|---|---|---|
| `Invocations` | Sum | Number of processor invocations recorded in the selected period |
| `Duration` | Average and Maximum | Observed execution time in milliseconds for invocations in that period |
| `Errors` | Sum | Invocations that ended with an error in that period |
| `Throttles` | Sum, if available | Invocations rejected because concurrency limits were reached |
| `ConcurrentExecutions` | Maximum, if available for the function dimension | Peak concurrent executions observed in that period |

Use the console's actual graph, dimensions, statistic, and period. Capture the time range and values for the presentation; do not infer a performance improvement from one run. A quiet graph can mean no test traffic in that period, not that processing is faster or error-free.

## Inspect processing logs and memory use

From that Lambda's **Monitor** page, open its CloudWatch logs. Select the log group for the deployed function (commonly `/aws/lambda/<deployed-function-name>`) and inspect log streams for the recorded test window. Correlate invocation timestamps with the images submitted and review application messages and Python errors.

Lambda's standard metrics do not provide a direct memory-utilization percentage by default. When present, the Lambda `REPORT` log line contains `Duration`, `Billed Duration`, `Memory Size`, and `Max Memory Used`. Use those observed values to explain configured versus peak memory for that invocation. Do not label configured memory as memory consumed, and do not claim a utilization percentage unless it is calculated from matching values and explicitly identified as a calculation.

The asynchronous EventBridge-triggered processor can run independently of the browser request. Compare the upload time, processor invocation metrics, and corresponding log timestamps. A delayed graph or missing log entry requires investigation; it is not evidence that processing succeeded.

## Safe demonstration sequence

1. Record account, region, function name, and selected CloudWatch time range.
2. Open the metrics before starting and note the baseline values shown by the console.
3. In an approved controlled test environment, submit a small, bounded burst (for example, no more than five small disposable images) through the normal CloudPix upload flow. This is an observation exercise, not a capacity or stress test. Do not run an unbounded load test or delete real images.
4. Observe `Invocations`, `Duration`, `Errors`, `Throttles`, and `ConcurrentExecutions` (if available) for the same function and period. Compare with an idle period only when the periods and metric settings are comparable.
5. Open matching log streams, inspect processing messages and `REPORT` lines, then check the dashboard for completion.
6. Record actual console observations with the time range and configuration. Report errors or missing data as observed; do not invent values or claim improved performance. A small burst cannot establish maximum capacity or prove scaling behavior at higher load.

CloudPix is serverless and event-driven. This project does not use a dedicated HPC cluster or a separate load balancer. API Gateway is the existing API entry point. Serverless scaling and resource utilization should be described using the observed Lambda metrics and logs, not claims about infrastructure that is not present.

CloudWatch ingestion and retention can incur charges. Keep the demonstration bounded and follow the project's approved test-stack and cleanup procedures. No cleanup or AWS change is performed by this guide.

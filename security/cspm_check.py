"""Small, dependency-free static checks for the CloudPix SAM template.

This checker reads template text only. It never calls AWS and cannot establish
the configuration of a deployed stack.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path


DEFAULT_TEMPLATE = Path(__file__).resolve().parents[1] / "template.yaml"
VALID_STATUSES = {"PASS", "FAIL", "REVIEW"}


@dataclass(frozen=True)
class Check:
    name: str
    status: str
    detail: str


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _block(text: str, key: str, indent: int) -> str | None:
    """Return a simple YAML mapping block at an exact indentation level."""
    lines = text.splitlines()
    header = re.compile(rf"^{re.escape(' ' * indent)}{re.escape(key)}:\s*(?:#.*)?$")
    for start, line in enumerate(lines):
        if not header.match(line):
            continue
        end = len(lines)
        for index in range(start + 1, len(lines)):
            candidate = lines[index]
            if candidate.strip() and not candidate.lstrip().startswith("#") and _indent(candidate) <= indent:
                end = index
                break
        return "\n".join(lines[start + 1:end])
    return None


def _scalar(text: str, key: str, min_indent: int = 0) -> str | None:
    """Find a scalar key in a scoped block, including keys under YAML lists."""
    pattern = re.compile(rf"^(?P<space> *)-?\s*{re.escape(key)}:\s*(?P<value>.*?)\s*$")
    for line in text.splitlines():
        match = pattern.match(line)
        if match and len(match.group("space")) >= min_indent:
            return match.group("value").split(" #", 1)[0].strip()
    return None


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _bool_setting(value: str | None) -> bool | None:
    if value is None:
        return None
    value = _unquote(value).lower()
    if value == "true":
        return True
    if value == "false":
        return False
    return None


def _api_route_settings(resources: str) -> tuple[dict[tuple[str, str], tuple[str | None, str | None]], bool]:
    """Read explicit SAM API events and report whether any has an Auth override."""
    function = _block(resources, "UploadHandler", 2)
    properties = _block(function or "", "Properties", 4)
    events = _block(properties or "", "Events", 6)
    if events is None:
        return {}, False

    event_names = re.findall(r"(?m)^        ([A-Za-z][A-Za-z0-9]*):\s*$", events)
    routes: dict[tuple[str, str], tuple[str | None, str | None]] = {}
    has_auth_override = False
    for event_name in event_names:
        event = _block(events, event_name, 8)
        if _unquote(_scalar(event or "", "Type", 10) or "") != "Api":
            continue
        event_properties = _block(event or "", "Properties", 10)
        if event_properties is None:
            continue
        path = _unquote(_scalar(event_properties, "Path", 12) or "")
        method = _unquote(_scalar(event_properties, "Method", 12) or "").lower()
        api_id = _unquote(_scalar(event_properties, "RestApiId", 12) or "")
        if path and method:
            routes[(path, method)] = (api_id, event_properties)
        if _block(event_properties, "Auth", 12) is not None:
            has_auth_override = True
    return routes, has_auth_override


def _origin_result(raw: str | None, template: str, parameter: str | None = None) -> tuple[str, str]:
    if raw is None:
        return "FAIL", "origin setting is missing from the template"

    # Resolve the common CloudFormation forms enough to identify a parameter's
    # declared default. The supplied deployment value is never available here.
    ref = re.search(r"!Ref\s+([A-Za-z0-9]+)", raw)
    sub = re.search(r"\$\{([A-Za-z0-9]+)(?:\.[A-Za-z0-9]+)?\}", raw)
    referenced = ref.group(1) if ref else sub.group(1) if sub else parameter
    if referenced:
        parameter_block = _block(_block(template, "Parameters", 0) or "", referenced, 2)
        default = _scalar(parameter_block or "", "Default", 4)
        if default is None:
            return "REVIEW", f"uses parameter {referenced}; effective origin is supplied at deployment"
        resolved = _unquote(default)
        if "*" in resolved:
            return "REVIEW", f"parameter {referenced} defaults to wildcard origin {resolved!r}; deployment overrides may differ"
        return "PASS", f"parameter {referenced} has a specific default origin {resolved!r}; deployment overrides may differ"

    origins = re.findall(r"['\"]([^'\"]+)['\"]", raw)
    candidate = origins[-1] if origins else _unquote(raw.strip("[] "))
    if "!" in candidate or "${" in candidate:
        return "REVIEW", "origin uses an intrinsic expression that this static checker cannot resolve"
    if "*" in candidate:
        return "REVIEW", f"wildcard origin {candidate!r} is configured"
    if candidate:
        return "PASS", f"specific origin {candidate!r} is configured"
    return "REVIEW", "origin value cannot be determined from the template text"


def analyze_template(template: str) -> list[Check]:
    """Analyze selected S3, API Gateway, CORS, and DynamoDB settings."""
    checks: list[Check] = []
    resources = _block(template, "Resources", 0)
    if resources is None:
        names = (
            "S3 public-access protections",
            "S3 default encryption",
            "S3 bucket CORS",
            "API Gateway authentication",
            "API Gateway CORS",
            "DynamoDB point-in-time recovery",
        )
        return [Check(name, "FAIL", "Resources section is missing from the template") for name in names]

    bucket = _block(resources, "ImagesBucket", 2)
    bucket_properties = _block(bucket or "", "Properties", 4)

    public_block = _block(bucket_properties or "", "PublicAccessBlockConfiguration", 6)
    public_keys = (
        "BlockPublicAcls",
        "IgnorePublicAcls",
        "BlockPublicPolicy",
        "RestrictPublicBuckets",
    )
    if bucket is None or public_block is None:
        checks.append(Check("S3 public-access protections", "FAIL", "bucket or PublicAccessBlockConfiguration is missing from the template"))
    else:
        values = {key: _bool_setting(_scalar(public_block, key, 8)) for key in public_keys}
        missing = [key for key, value in values.items() if value is None and _scalar(public_block, key, 8) is None]
        unknown = [key for key, value in values.items() if value is None and key not in missing]
        disabled = [key for key, value in values.items() if value is False]
        if disabled or missing:
            details = []
            if disabled:
                details.append("explicitly disabled: " + ", ".join(disabled))
            if missing:
                details.append("missing: " + ", ".join(missing))
            checks.append(Check("S3 public-access protections", "FAIL", "; ".join(details)))
        elif unknown:
            checks.append(Check("S3 public-access protections", "REVIEW", "cannot resolve: " + ", ".join(unknown)))
        else:
            checks.append(Check("S3 public-access protections", "PASS", "all four bucket public-access-block settings are true in the template"))

    encryption = _block(bucket_properties or "", "BucketEncryption", 6)
    algorithm = _scalar(encryption or "", "SSEAlgorithm", 0)
    if bucket is None or encryption is None or algorithm is None:
        checks.append(Check("S3 default encryption", "FAIL", "bucket encryption configuration or SSEAlgorithm is missing from the template"))
    elif "!" in algorithm or "${" in algorithm:
        checks.append(Check("S3 default encryption", "REVIEW", f"SSEAlgorithm {algorithm!r} cannot be resolved statically"))
    elif _unquote(algorithm) in {"AES256", "aws:kms", "aws:kms:dsse"}:
        checks.append(Check("S3 default encryption", "PASS", f"server-side encryption uses {_unquote(algorithm)} in the template"))
    else:
        checks.append(Check("S3 default encryption", "FAIL", f"unrecognized or unsafe SSEAlgorithm {_unquote(algorithm)!r}"))

    bucket_cors = _block(bucket_properties or "", "CorsConfiguration", 6)
    bucket_origins = _scalar(bucket_cors or "", "AllowedOrigins", 0)
    bucket_methods = _scalar(bucket_cors or "", "AllowedMethods", 0)
    if bucket is None or bucket_cors is None or bucket_origins is None or bucket_methods is None:
        checks.append(Check("S3 bucket CORS", "FAIL", "bucket CORS origins or methods are missing from the template"))
    else:
        origin_status, origin_detail = _origin_result(bucket_origins, template)
        checks.append(Check("S3 bucket CORS", origin_status, origin_detail + "; inspect the deployment parameter and live bucket separately"))

    api = _block(resources, "CloudPixApi", 2)
    api_properties = _block(api or "", "Properties", 4)
    auth = _block(api_properties or "", "Auth", 6)
    authorizer_name = _scalar(auth or "", "DefaultAuthorizer", 8)
    authorizers = _block(auth or "", "Authorizers", 8)
    authorizer_configured = bool(authorizer_name and authorizers and re.search(
        rf"(?m)^\s{{10}}{re.escape(authorizer_name)}:", authorizers
    ))
    preflight_value = _bool_setting(_scalar(auth or "", "AddDefaultAuthorizerToCorsPreflight", 8))
    if api is None or auth is None or not authorizer_configured:
        checks.append(Check("API Gateway authentication", "FAIL", "no API authorizer is configured in the template; API routes are unauthenticated"))
    elif preflight_value is True:
        checks.append(Check("API Gateway authentication", "FAIL", "default authorizer is configured on generated OPTIONS preflight methods"))
    elif preflight_value is None:
        checks.append(Check("API Gateway authentication", "REVIEW", "default authorizer exists, but OPTIONS preflight authorizer behavior is not explicit"))
    else:
        required_routes = (("/uploads", "post"), ("/history", "get"), ("/images/{image_id}", "get"))
        routes, auth_override = _api_route_settings(resources)
        missing_routes = [f"{method.upper()} {path}" for path, method in required_routes if (path, method) not in routes]
        wrong_api = [f"{method.upper()} {path}" for path, method in required_routes if (path, method) in routes and routes[(path, method)][0] != "!Ref CloudPixApi"]
        if missing_routes or wrong_api:
            details = []
            if missing_routes:
                details.append("missing expected API events: " + ", ".join(missing_routes))
            if wrong_api:
                details.append("events do not reference CloudPixApi: " + ", ".join(wrong_api))
            checks.append(Check("API Gateway authentication", "FAIL", "; ".join(details)))
        elif auth_override:
            checks.append(Check("API Gateway authentication", "REVIEW", "default Cognito authorizer and unauthenticated preflight are configured, but one or more API events override default authorization"))
        else:
            checks.append(Check("API Gateway authentication", "PASS", f"default authorizer {authorizer_name} covers the three expected API events; generated OPTIONS preflight is explicitly unauthenticated"))

    api_cors = _block(api_properties or "", "Cors", 6)
    api_origin = _scalar(api_cors or "", "AllowOrigin", 8)
    api_methods = _scalar(api_cors or "", "AllowMethods", 8)
    api_headers = _scalar(api_cors or "", "AllowHeaders", 8)
    if api is None or api_cors is None or api_origin is None or api_methods is None or api_headers is None:
        checks.append(Check("API Gateway CORS", "FAIL", "API CORS origin, methods, or headers are missing from the template"))
    elif "Authorization" not in api_headers:
        checks.append(Check("API Gateway CORS", "FAIL", "AllowHeaders does not include Authorization"))
    elif "OPTIONS" not in api_methods:
        checks.append(Check("API Gateway CORS", "FAIL", "AllowMethods does not include OPTIONS"))
    else:
        origin_status, origin_detail = _origin_result(api_origin, template)
        checks.append(Check("API Gateway CORS", origin_status, origin_detail + "; actual deployment origin is not verified"))

    table = _block(resources, "ImagesTable", 2)
    table_properties = _block(table or "", "Properties", 4)
    recovery = _block(table_properties or "", "PointInTimeRecoverySpecification", 6)
    recovery_enabled_raw = _scalar(recovery or "", "PointInTimeRecoveryEnabled", 8)
    recovery_enabled = _bool_setting(recovery_enabled_raw)
    if table is None or recovery is None or recovery_enabled_raw is None:
        checks.append(Check("DynamoDB point-in-time recovery", "FAIL", "PointInTimeRecoverySpecification is missing from the template"))
    elif recovery_enabled is True:
        checks.append(Check("DynamoDB point-in-time recovery", "PASS", "point-in-time recovery is enabled in the template"))
    elif recovery_enabled is False:
        checks.append(Check("DynamoDB point-in-time recovery", "FAIL", "point-in-time recovery is explicitly disabled in the template"))
    else:
        checks.append(Check("DynamoDB point-in-time recovery", "REVIEW", f"cannot resolve setting {recovery_enabled_raw!r}"))

    return checks


def render(checks: list[Check]) -> str:
    counts = {status: sum(check.status == status for check in checks) for status in VALID_STATUSES}
    lines = ["CloudPix CSPM - static template review only; live AWS settings were not inspected."]
    lines.extend(f"{check.status}: {check.name} - {check.detail}" for check in checks)
    lines.append(f"Summary: {counts['PASS']} PASS, {counts['FAIL']} FAIL, {counts['REVIEW']} REVIEW")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("template", nargs="?", type=Path, default=DEFAULT_TEMPLATE, help="SAM/CloudFormation template (default: repository template.yaml)")
    args = parser.parse_args(argv)
    try:
        content = args.template.read_text(encoding="utf-8")
    except OSError as exc:
        checks = [Check("Template input", "REVIEW", f"could not read {args.template}: {exc}")]
        print(render(checks))
        return 2

    checks = analyze_template(content)
    print(render(checks))
    return 1 if any(check.status == "FAIL" for check in checks) else 0


if __name__ == "__main__":
    sys.exit(main())

#!/bin/sh
# Chaapo — MinIO bucket bootstrap.
#
# Creates the two private buckets the app uses and asserts they are not public.
# Idempotent: safe to re-run.
#
#   chaapo-files   customer print files (private, versioned, lifecycle-expired)
#   chaapo-assets  shop photos, KYC documents, generated invoices (private)
#
# NFR-12: files are never publicly readable. Access is only ever granted through
# short-lived presigned URLs issued after an authorisation check.

set -eu

MINIO_ALIAS=local
MINIO_URL=${MINIO_URL:-http://minio:9000}
MINIO_USER=${MINIO_ROOT_USER:-chaapo}
MINIO_PASS=${MINIO_ROOT_PASSWORD:-chaapo-dev-secret}
FILES_BUCKET=${FILES_BUCKET:-chaapo-files}
ASSETS_BUCKET=${ASSETS_BUCKET:-chaapo-assets}

echo "[minio-init] waiting for $MINIO_URL"
until mc alias set "$MINIO_ALIAS" "$MINIO_URL" "$MINIO_USER" "$MINIO_PASS" >/dev/null 2>&1; do
  sleep 1
done
echo "[minio-init] connected"

for bucket in "$FILES_BUCKET" "$ASSETS_BUCKET"; do
  if mc ls "$MINIO_ALIAS/$bucket" >/dev/null 2>&1; then
    echo "[minio-init] bucket $bucket exists"
  else
    mc mb --region ap-south-1 "$MINIO_ALIAS/$bucket"
    echo "[minio-init] created $bucket"
  fi

  # Explicitly deny anonymous access. This is the default, but we assert it so a
  # misconfigured environment fails loudly rather than silently leaking files.
  mc anonymous set none "$MINIO_ALIAS/$bucket" >/dev/null
  mc version enable "$MINIO_ALIAS/$bucket" >/dev/null

  policy=$(mc anonymous get "$MINIO_ALIAS/$bucket" 2>/dev/null || true)
  case "$policy" in
    *download* | *public* )
      echo "[minio-init] FATAL: bucket $bucket is publicly readable" >&2
      exit 1
      ;;
  esac
done

# Retention safety net. The authoritative deletion path is the `retention.sweep`
# worker, which deletes objects and writes an audit row (FR-902, FR-903). This
# lifecycle rule is defence in depth so an orphaned object cannot outlive the
# maximum retention window even if the worker never runs.
cat >/tmp/lifecycle.json <<'JSON'
{
  "Rules": [
    {
      "ID": "chaapo-order-files-hard-cap",
      "Status": "Enabled",
      "Filter": { "Prefix": "orders/" },
      "Expiration": { "Days": 120 },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 7 }
    },
    {
      "ID": "chaapo-draft-uploads-sweep",
      "Status": "Enabled",
      "Filter": { "Prefix": "drafts/" },
      "Expiration": { "Days": 7 },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }
  ]
}
JSON
mc ilm import "$MINIO_ALIAS/$FILES_BUCKET" </tmp/lifecycle.json >/dev/null 2>&1 || \
  echo "[minio-init] warning: could not import lifecycle rules (non-fatal in dev)"

echo "[minio-init] done — buckets are private"

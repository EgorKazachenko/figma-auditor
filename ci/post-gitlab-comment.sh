#!/usr/bin/env bash
# Posts (or, with DRY_RUN=1, prints) the drift comment on the merge request. Uses GitLab's predefined CI
# variables and a project access token in DESIGN_AUDIT_TOKEN. Without the token it only prints.
set -euo pipefail
file="${1:?comment file}"
[ -s "$file" ] || { echo "no comment to post"; exit 0; }
if [ "${DRY_RUN:-0}" = "1" ] || [ -z "${DESIGN_AUDIT_TOKEN:-}" ]; then
  echo "--- MR comment (not posted: DRY_RUN or no DESIGN_AUDIT_TOKEN) ---"
  cat "$file"
  exit 0
fi
url="$CI_API_V4_URL/projects/$CI_PROJECT_ID/merge_requests/$CI_MERGE_REQUEST_IID/notes"
curl --fail --silent --show-error --request POST --header "PRIVATE-TOKEN: $DESIGN_AUDIT_TOKEN" \
  --form-string "body=$(cat "$file")" "$url" > /dev/null
echo "comment posted to MR !$CI_MERGE_REQUEST_IID"

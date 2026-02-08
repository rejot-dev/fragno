#!/bin/bash

# Script to add a rating (upvote/downvote) to a reference
# Usage: ./scripts/add-rating.sh <reference> [rating]
#   reference: The reference ID to rate
#   rating: Optional. Positive number for upvote, negative for downvote. Defaults to 1 (upvote)

set -e

# Configuration
BASE_URL="${BASE_URL:-http://localhost:3000}"
RATING_MOUNT="${RATING_MOUNT:-/api/fragno-db-rating}"

# Parse arguments
REFERENCE="${1}"
RATING="${2:-1}"

# Validate arguments
if [ -z "$REFERENCE" ]; then
  echo "Error: Reference ID is required"
  echo "Usage: $0 <reference> [rating]"
  echo "  reference: The reference ID to rate"
  echo "  rating: Optional. Positive number for upvote, negative for downvote. Defaults to 1 (upvote)"
  exit 1
fi

# Build JSON payload using jq if available, otherwise use basic construction
if command -v jq >/dev/null 2>&1; then
  PAYLOAD=$(jq -n \
    --arg reference "$REFERENCE" \
    --argjson rating "$RATING" \
    '{reference: $reference, rating: $rating}')
else
  PAYLOAD="{\"reference\": \"$REFERENCE\", \"rating\": $RATING}"
fi

# Make the request
echo "Adding rating to reference: $REFERENCE"
echo "Rating value: $RATING"
echo ""

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$BASE_URL$RATING_MOUNT/upvotes")

# Split response and status code (macOS compatible)
HTTP_BODY=$(echo "$RESPONSE" | sed '$d')
HTTP_CODE=$(echo "$RESPONSE" | tail -n 1)

# Check response
if [ "$HTTP_CODE" -eq 200 ] || [ "$HTTP_CODE" -eq 201 ]; then
  echo "✓ Rating added successfully"
  echo "Response: $HTTP_BODY"
else
  echo "✗ Failed to add rating (HTTP $HTTP_CODE)"
  echo "Response: $HTTP_BODY"
  exit 1
fi

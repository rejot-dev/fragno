#!/bin/bash

# Script to create a comment
# Usage: ./scripts/create-comment.sh <title> <content> <postReference> <userReference> [parentId]
#   title: Comment title
#   content: Comment content
#   postReference: Post reference ID
#   userReference: User reference ID
#   parentId: Optional parent comment ID for nested comments

set -e

# Configuration
BASE_URL="${BASE_URL:-http://localhost:3000}"
COMMENT_MOUNT="${COMMENT_MOUNT:-/api/fragno-db-comment}"

# Parse arguments
TITLE="${1}"
CONTENT="${2}"
POST_REFERENCE="${3}"
USER_REFERENCE="${4}"
PARENT_ID="${5}"

# Validate required arguments
if [ -z "$TITLE" ] || [ -z "$CONTENT" ] || [ -z "$POST_REFERENCE" ] || [ -z "$USER_REFERENCE" ]; then
  echo "Error: Missing required arguments"
  echo "Usage: $0 <title> <content> <postReference> <userReference> [parentId]"
  echo "  title: Comment title"
  echo "  content: Comment content"
  echo "  postReference: Post reference ID"
  echo "  userReference: User reference ID"
  echo "  parentId: Optional parent comment ID for nested comments"
  exit 1
fi

# Build JSON payload using jq if available, otherwise use printf for basic escaping
if command -v jq >/dev/null 2>&1; then
  if [ -n "$PARENT_ID" ]; then
    PAYLOAD=$(jq -n \
      --arg title "$TITLE" \
      --arg content "$CONTENT" \
      --arg postReference "$POST_REFERENCE" \
      --arg userReference "$USER_REFERENCE" \
      --arg parentId "$PARENT_ID" \
      '{title: $title, content: $content, postReference: $postReference, userReference: $userReference, parentId: $parentId}')
  else
    PAYLOAD=$(jq -n \
      --arg title "$TITLE" \
      --arg content "$CONTENT" \
      --arg postReference "$POST_REFERENCE" \
      --arg userReference "$USER_REFERENCE" \
      '{title: $title, content: $content, postReference: $postReference, userReference: $userReference}')
  fi
else
  # Fallback: basic JSON construction (may fail with special characters)
  if [ -n "$PARENT_ID" ]; then
    PAYLOAD="{\"title\": \"$TITLE\", \"content\": \"$CONTENT\", \"postReference\": \"$POST_REFERENCE\", \"userReference\": \"$USER_REFERENCE\", \"parentId\": \"$PARENT_ID\"}"
  else
    PAYLOAD="{\"title\": \"$TITLE\", \"content\": \"$CONTENT\", \"postReference\": \"$POST_REFERENCE\", \"userReference\": \"$USER_REFERENCE\"}"
  fi
fi

# Make the request
echo "Creating comment..."
echo "Title: $TITLE"
echo "Post Reference: $POST_REFERENCE"
echo "User Reference: $USER_REFERENCE"
[ -n "$PARENT_ID" ] && echo "Parent ID: $PARENT_ID"
echo ""

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$BASE_URL$COMMENT_MOUNT/comments")

# Split response and status code (macOS compatible)
HTTP_BODY=$(echo "$RESPONSE" | sed '$d')
HTTP_CODE=$(echo "$RESPONSE" | tail -n 1)

# Check response
if [ "$HTTP_CODE" -eq 200 ] || [ "$HTTP_CODE" -eq 201 ]; then
  echo "✓ Comment created successfully"
  echo "Response:"
  echo "$HTTP_BODY" | jq '.' 2>/dev/null || echo "$HTTP_BODY"
else
  echo "✗ Failed to create comment (HTTP $HTTP_CODE)"
  echo "Response: $HTTP_BODY"
  exit 1
fi

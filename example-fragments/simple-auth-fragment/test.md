```bash
# 1. Create a user and save the session ID
RESPONSE=$(curl -s -X POST http://localhost:5173/api/simple-auth/sign-up \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"mypassword123"}')

echo "Sign-up response: $RESPONSE"

# Extract sessionId (requires jq - install with: brew install jq)
SESSION_ID=$(echo $RESPONSE | jq -r '.sessionId')

# 2. Check current user
curl -X GET "http://localhost:5173/api/simple-auth/me?sessionId=$SESSION_ID"

# 3. Sign out
curl -X POST http://localhost:5173/api/simple-auth/sign-out \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SESSION_ID\"}"

# 4. Verify session is invalid
curl -X GET "http://localhost:5173/api/simple-auth/me?sessionId=$SESSION_ID"
```

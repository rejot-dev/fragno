```bash
# 1. Create a user and save the session ID
RESPONSE=$(curl -s -X POST http://localhost:5173/api/auth/sign-up \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"mypassword123"}')

echo "Sign-up response: $RESPONSE"

# Extract sessionId (requires jq - install with: brew install jq)
SESSION_ID=$(echo $RESPONSE | jq -r '.sessionId')

# 2. Check current user (/me bootstrap payload)
curl -X GET "http://localhost:5173/api/auth/me?sessionId=$SESSION_ID"

# 3. Create an organization
ORG_RESPONSE=$(curl -s -X POST http://localhost:5173/api/auth/organizations?sessionId=$SESSION_ID \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme","slug":"acme"}')

ORG_ID=$(echo $ORG_RESPONSE | jq -r '.organization.id')

# 4. List organizations for the current user
curl -X GET "http://localhost:5173/api/auth/organizations?sessionId=$SESSION_ID"

# 5. Set the active organization
curl -X POST "http://localhost:5173/api/auth/organizations/active?sessionId=$SESSION_ID" \
  -H "Content-Type: application/json" \
  -d "{\"organizationId\":\"$ORG_ID\"}"

# 6. Invite a member (returns invitation token)
INVITE_RESPONSE=$(curl -s -X POST \
  "http://localhost:5173/api/auth/organizations/$ORG_ID/invitations?sessionId=$SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{"email":"invitee@example.com","roles":["member"]}')

INVITE_ID=$(echo $INVITE_RESPONSE | jq -r '.invitation.id')
INVITE_TOKEN=$(echo $INVITE_RESPONSE | jq -r '.invitation.token')

# 7. Create the invitee user and capture their session ID
INVITEE_RESPONSE=$(curl -s -X POST http://localhost:5173/api/auth/sign-up \
  -H "Content-Type: application/json" \
  -d '{"email":"invitee@example.com","password":"inviteepassword123"}')

INVITEE_SESSION_ID=$(echo $INVITEE_RESPONSE | jq -r '.sessionId')

# 8. Accept or reject the invitation as the invitee
curl -X PATCH "http://localhost:5173/api/auth/organizations/invitations/$INVITE_ID?sessionId=$INVITEE_SESSION_ID" \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"accept\",\"token\":\"$INVITE_TOKEN\"}"

# 9. Sign out
curl -X POST http://localhost:5173/api/auth/sign-out \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SESSION_ID\"}"

# 10. Verify session is invalid
curl -X GET "http://localhost:5173/api/auth/me?sessionId=$SESSION_ID"
```

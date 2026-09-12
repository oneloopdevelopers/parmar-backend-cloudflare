# Backend API Service (Node.js + Express + Firebase Admin SDK)

This project is a dedicated **server-side REST API backend** configured to connect directly with your existing Firebase project:

**Target Firebase Project ID:** `document-portal-d2b6d`

---

## Architecture & Security Principles

1. **Shared Existing Firebase Project (`document-portal-d2b6d`)**:
   - Uses the exact same Firebase Project as the Android client app.
   - Does **not** create a new Firebase project, auth realm, or separate database.
   - Reads directly from the shared Firestore database collection (`users/{firebaseUid}`).

2. **Zero-Trust Client Identity**:
   - The Android client authenticates with Firebase Authentication and sends an ID token:
     ```http
     Authorization: Bearer <Firebase ID Token>
     ```
   - The backend verifies this ID token using the Firebase Admin SDK (`src/config/firebaseAdmin.ts`) and extracts the cryptographically verified `firebaseUid`.
   - **Crucial Security Rule**: The backend **never** trusts a Firebase UID, PAN number, client ID, or Google Drive folder ID supplied in request data.
   - The verified UID is used by the backend to fetch the authoritative profile from Firestore:
     ```
     Firestore: users/{firebaseUid}
     ```
   - The client's `driveFolderId` is strictly retrieved from this Firestore document, ensuring clients cannot access or upload to arbitrary Google Drive folders.

---

## API Endpoints

| Method | Endpoint | Auth Required | Description |
|---|---|---|---|
| `GET` | `/api/health` | No | Public health check, server status & Firebase Admin status |
| `GET` | `/api/health/firebase` | Optional | Verifies Firebase Admin SDK initialization & live Firestore communication on project `document-portal-d2b6d` |
| `GET` | `/api/profile` | **Yes** (Bearer Token) | Returns user profile (`name`, `email`, `phone`, `maskedPanNumber`, `role`, `status`) from Firestore `users/{firebaseUid}` |

> **Note on Future Capabilities**: As requested, Google Drive integration and document upload/download endpoints (`/api/documents`) are deferred for the subsequent phase.

---

## Centralized Firebase Admin Module (`src/config/firebaseAdmin.ts`)

The module safely manages initialization and exports:
- `auth`: Firebase Authentication instance & token verification (`getAuthInstance()`)
- `db`: Cloud Firestore instance (`getFirestoreInstance()`)
- `validateFirebaseAdminStartup()`: Startup validation reporting initialization status to console logs.
- `testFirestoreConnectivity()`: Validates live communication with Cloud Firestore on project `document-portal-d2b6d`.

---

## Authentication Middleware (`src/middleware/authenticateFirebaseUser.ts`)

The `authenticateFirebaseUser` middleware enforces zero-trust identity verification:
1. Reads `Authorization: Bearer <Firebase ID Token>`.
2. Verifies cryptographic signature and expiry with Firebase Admin SDK.
3. Obtains verified Firebase UID.
4. Verifies the user exists and is not disabled in Firebase Authentication.
5. Loads the client profile from `users/{firebaseUid}` in Cloud Firestore.
6. Rejects requests with appropriate HTTP status codes:
   - **401 Unauthorized**: Missing header, malformed token, expired token, invalid token, or nonexistent Firebase user.
   - **403 Forbidden**: Disabled Firebase account or inactive/disabled/suspended Firestore client status.
   - **404 Not Found**: Missing client profile document in Firestore `users/{firebaseUid}`.
7. Attaches `req.user` and `req.clientProfile` to the request context.

### Automated Tests
Run the automated test suite covering authentication, token verification, client repository, and profile retrieval:
```bash
npm test
```
The test suite executes 24 unit and integration tests verifying:
- Token format parsing and signature validation
- Firestore `users/{firebaseUid}` resolution
- `getClientByUid`, `getClientProfileByUid`, and `isClientActive` methods
- Validation for missing and malformed client profiles
- PAN number masking (`XXXXXX234F`)
- Strict exclusion of `driveFolderId` from client-facing payloads
- Rejection of client-supplied arbitrary UIDs

---

## Firestore Client Repository (`src/repositories/clientRepository.ts`)

The centralized `ClientRepository` encapsulates all read operations for client records in the `users/{firebaseUid}` Firestore collection.

### Methods Implemented

| Method | Signature | Description |
| :--- | :--- | :--- |
| `getClientByUid` | `getClientByUid(uid: string): Promise<ClientDocument \| null>` | Retrieves the full internal document including `driveFolderId` for server authorization. Throws on malformed records. |
| `getClientProfileByUid` | `getClientProfileByUid(uid: string): Promise<ClientProfileResponse>` | Retrieves the client profile, validates fields, masks `panNumber`, and **strictly excludes `driveFolderId`**. |
| `isClientActive` | `isClientActive(uid: string): Promise<boolean>` | Returns `true` only if the document exists and `status === 'active'`. |

### Security & Privacy Protections

1. **Token-Only UID Authority**: The UID is derived solely from the cryptographically verified Firebase ID token. The repository rejects path traversal characters, and the API layer rejects any request where a client attempts to pass a custom `uid`, `userId`, or `panNumber` in body, query, or parameters.
2. **Missing & Malformed Profile Validation**: The repository validates all mandatory schema fields (`name`, valid `email`, `phone`, `panNumber`, `driveFolderId`, `role`, `status`). Missing or malformed records in Firestore throw clear `400 Bad Request` errors.
3. **Private Authorization Storage**: `driveFolderId` is an authoritative server-side credential used exclusively by the backend for Google Drive operations. It is never transmitted in client responses.
4. **PAN Masking**: Client PAN numbers are masked before leaving the server (e.g., `ABCDE1234F` -> `XXXXXX234F`).

---

## Endpoint: `GET /api/profile`

Returns the authenticated client's verified profile information.

### Request Headers
```http
Authorization: Bearer <Firebase ID Token>
```

### Response (`200 OK`)
```json
{
  "success": true,
  "name": "Jane Doe",
  "email": "jane.doe@example.com",
  "phone": "+91 9876543210",
  "maskedPanNumber": "XXXXXX234F",
  "role": "client",
  "status": "active"
}
```

---

## How Firebase Credentials Will Be Configured

To maintain security, **no service account keys or credentials are hardcoded into the source code**.

When deploying or running in production, configure the Firebase Admin SDK using one of the following methods:

### Method 1: Google Cloud Application Default Credentials (ADC) - Preferred

When running in Google Cloud environments (Cloud Run):
1. Assign the **Firebase Authentication Viewer** and **Cloud Datastore User** (Firestore) IAM roles to the runtime service account.
2. The Firebase Admin SDK automatically authenticates via ADC targeting `document-portal-d2b6d` without requiring private key files!

### Method 2: Environment Variables (Cloud Run Secrets / Container Config)

Set the following environment variables:

```bash
# Firebase Project ID
FIREBASE_PROJECT_ID="document-portal-d2b6d"

# Service Account Client Email
FIREBASE_CLIENT_EMAIL="firebase-adminsdk-xxxxx@document-portal-d2b6d.iam.gserviceaccount.com"

# Service Account Private Key (include \n line breaks)
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...\n-----END PRIVATE KEY-----\n"
```

Alternatively, provide the entire JSON content in a single variable:

```bash
FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"document-portal-d2b6d",...}'
```

### Method 3: Service Account Key File (Local Development)

For local development outside of GCP:
1. Download a service account key JSON file from **Firebase Console > Project Settings > Service Accounts**.
2. Save it outside your git repository (e.g. `credentials/service-account.json`).
3. Set the environment variable:
   ```bash
   export GOOGLE_APPLICATION_CREDENTIALS="/absolute/path/to/service-account.json"
   ```

---

## Firestore Data Schema

The backend expects the client profile at path:

```
users/{firebaseUid}
```

Document structure:
```json
{
  "name": "Jane Doe",
  "email": "jane.doe@example.com",
  "phone": "+91 9876543210",
  "panNumber": "ABCDE1234F",
  "driveFolderId": "1a2B3c4D5e6F7g8H9i",
  "role": "client",
  "status": "active",
  "createdAt": "2026-01-15T10:00:00Z",
  "updatedAt": "2026-09-10T12:00:00Z"
}
```

---

## Connecting the Android Application

In your Android application (Kotlin / Java):

1. Authenticate the user with Firebase Authentication (`signInWithEmailAndPassword`).
2. Retrieve the Firebase ID Token:
   ```kotlin
   val user = FirebaseAuth.getInstance().currentUser
   user?.getIdToken(true)?.addOnCompleteListener { task ->
       if (task.isSuccessful) {
           val idToken = task.result?.token
           // Send this token in your HTTP request:
           // Header: "Authorization: Bearer $idToken"
       }
   }
   ```
3. Call backend endpoints:
   - `GET https://your-backend-url.run.app/api/profile`
   - `GET https://your-backend-url.run.app/api/documents`

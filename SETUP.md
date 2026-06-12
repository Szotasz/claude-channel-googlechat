# Google Chat + GCP setup

One-time setup to wire a Google Chat app to this plugin over Cloud Pub/Sub. You
need a GCP project and (for the recommended email path) Workspace admin access.

Throughout, `<p>` is your GCP project id.

## 1. Project + APIs

```bash
gcloud config set project <p>
gcloud services enable chat.googleapis.com pubsub.googleapis.com
# only if you'll use Directory email resolution (recommended):
gcloud services enable admin.googleapis.com
```

## 2. Pub/Sub topic + subscription

```bash
gcloud pubsub topics create chat-inbound
# one subscription PER agent/session (do not share):
gcloud pubsub subscriptions create chat-sub-main --topic=chat-inbound
```

`chat-sub-main` (or its full path) is your `GOOGLECHAT_SUBSCRIPTION`.

## 3. Let Google Chat publish to the topic

Google Chat publishes events as a system service account. Grant it Publisher on
the topic:

```bash
gcloud pubsub topics add-iam-policy-binding chat-inbound \
  --member="serviceAccount:chat-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"
```

## 4. App service account + key

```bash
gcloud iam service-accounts create gchat-app --display-name="Google Chat app"
gcloud iam service-accounts keys create sa-key.json \
  --iam-account="gchat-app@<p>.iam.gserviceaccount.com"
```

Grant it Subscriber on the subscription:

```bash
gcloud pubsub subscriptions add-iam-policy-binding chat-sub-main \
  --member="serviceAccount:gchat-app@<p>.iam.gserviceaccount.com" \
  --role="roles/pubsub.subscriber"
```

Move `sa-key.json` somewhere safe and point the plugin at it
(`/googlechat:configure key /abs/path/sa-key.json`). It is **not** committed
(see `.gitignore`).

## 5. Configure the Chat API app

In the Google Cloud Console → **APIs & Services → Google Chat API →
Configuration**:

- **App name**, avatar, description.
- **Connection settings → Cloud Pub/Sub**, topic = `projects/<p>/topics/chat-inbound`.
- **"Build this Chat app as a Google Workspace add-on" = DISABLED.**
- **Permissions** — who can install / which users or domain.
- The app authenticates to the Chat REST API as the `gchat-app` service account
  with scope `https://www.googleapis.com/auth/chat.bot`.

## 6. (Recommended) Directory email resolution

So the plugin can turn `users/<id>` into a real email:

1. Note the `gchat-app` service account's **OAuth client id** (numeric).
2. Workspace **Admin console → Security → Access and data control → API controls
   → Domain-wide delegation → Add new**:
   - Client id = the service account's client id
   - Scope = `https://www.googleapis.com/auth/admin.directory.user.readonly`
3. Set `GOOGLECHAT_ADMIN_IMPERSONATE=<an-admin@yourdomain>` in the plugin `.env`
   (the service account impersonates this admin for Directory reads).

Without this, rely on event-provided email (if your config includes it) or the
id-fallback allowlist (put `users/<id>` values in `allowFrom`/`owner`).

## 7. Install the app + go

- Install/add the app (admin install, or just DM the app / add it to a space).
- `/googlechat:configure` → save `key`, `project`, `subscription` (+ `admin`).
- `/googlechat:access owner you@yourcompany.com`, then add users/domain.
- Relaunch: `claude --channels plugin:googlechat@claude-channel-googlechat`.

## 8. Verify without the real app (optional)

You can exercise inbound by publishing a synthetic event to the topic, which
your subscription receives just like a real Chat event:

```bash
gcloud pubsub topics publish chat-inbound --message='{
  "type":"MESSAGE",
  "space":{"name":"spaces/TEST","type":"DM"},
  "message":{
    "name":"spaces/TEST/messages/m1",
    "text":"hello from a test event",
    "createTime":"2026-06-12T10:00:00Z",
    "sender":{"name":"users/123","displayName":"Tester","email":"you@yourcompany.com"}
  }
}'
```

With `owner` set to `you@yourcompany.com`, this should surface in the session as
a `<channel source="googlechat" ... role="owner">` block.

## Managed-settings note (some hosts)

If a host enforces `/etc/claude-code/managed-settings.json`
`allowedChannelPlugins`, add `googlechat@claude-channel-googlechat` to that list
or inbound notifications are silently dropped.

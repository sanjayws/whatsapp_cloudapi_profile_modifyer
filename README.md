# WhatsApp Business Profile Manager (Cloudflare Worker)

A lightweight web interface to **view and update your WhatsApp Business Profile** using the WhatsApp Cloud API.  
No database is required — all data is **ephemeral** and sent directly from your browser to the Meta Graph API via the Cloudflare Worker.

---

## ✨ Features

- Load existing WhatsApp Business profile data
- Edit:
  - About / Status
  - Vertical / Category
  - Email
  - Address
  - Description
  - Websites (up to 2)
  - Profile Picture (via resumable upload)
- **Safe updates** — only sends changed fields to WhatsApp
- Confirmation dialog showing exactly which fields will be updated
- Cancel and return to edit if needed
- Prevents editing until profile data is loaded
- Clean, light, responsive UI in a boxed layout
- No backend storage of tokens or profile data

---

## 📸 Demo

<img width="2012" height="1980" alt="image" src="https://github.com/user-attachments/assets/937a8e9b-524a-45f6-862a-c174c37d8c1d" />

---

## 🔑 Credentials Explained

This tool works with the [WhatsApp Business Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/).

You will need:

| Name                | Required? | Description                                                                                  | Where to Find                                                                                                   |
|---------------------|-----------|----------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------|
| **Phone Number ID** | ✅         | Unique ID for your WhatsApp Business phone number                                           | Meta Developer Dashboard → Your App → WhatsApp → API Setup                                                      |
| **Access Token**    | ✅         | Permanent access token (recommended) for calling the Cloud API                              | Meta Developer Dashboard → Your App → WhatsApp → API Setup → "Permanent token" section                          |
| **App ID**          | ❌ (for profile update) | Meta App ID. Not required for viewing/updating profile fields in this tool. Needed only for certain endpoints like media uploads using App-scoped IDs. | Meta Developer Dashboard → Your App → App Settings → Basic Information                                          |

**For this tool**, you only need:
- `PHONE_NUMBER_ID`
- `ACCESS_TOKEN`

---

## ☁️ Cloudflare Setup

You can use this tool in two ways:

### **Option 1: Enter credentials in the UI (ephemeral, no storage)**
- Visit your deployed Worker URL
- Enter your **Phone Number ID** and **Access Token** each time
- Credentials are kept in memory only for that session

### **Option 2: Store credentials in Cloudflare Worker environment variables**
1. In Cloudflare Dashboard → Your Worker → **Settings** → **Variables**
2. Add:
   - `WA_PHONE_NUMBER_ID` → your Phone Number ID
   - `WA_ACCESS_TOKEN` → your Permanent Access Token
3. Modify `worker.js` to use these variables:
   ```js
   const PHONE_NUMBER_ID = WA_PHONE_NUMBER_ID; // from Cloudflare env
   const ACCESS_TOKEN = WA_ACCESS_TOKEN;       // from Cloudflare env

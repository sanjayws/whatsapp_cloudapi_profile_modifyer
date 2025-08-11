# WhatsApp Business Profile Manager (Cloudflare Worker)

A lightweight web interface to **view and update your WhatsApp Business Profile** using the WhatsApp Cloud API.  
No database is required — all data is **ephemeral** and sent directly from your browser to the Meta Graph API via the Worker.

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
- Clean, light, responsive UI in a boxed layout
- No backend storage of tokens or profile data

---

## 📸 Demo

![Screenshot of WhatsApp Business Profile Manager UI](docs/screenshot-ui.png)

---

## 🚀 Deployment

### 1. Prerequisites

- [Cloudflare Workers account](https://dash.cloudflare.com/)
- [Meta developer account](https://developers.facebook.com/)
- WhatsApp Business Cloud API **Phone Number ID** and **Permanent Access Token**

---

### 2. Get Your WhatsApp Credentials

1. Go to [Meta Developer Dashboard](https://developers.facebook.com/apps/)
2. Select your app > **WhatsApp** > **API Setup**
3. Copy:
   - **Phone Number ID**
   - **Permanent Access Token** (not a temporary token)

---

### 3. Deploy to Cloudflare

**Option A — Using Wrangler CLI**
```bash
# Install Wrangler CLI
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Clone this repo
git clone https://github.com/YOUR_USERNAME/wa-business-profile-manager.git
cd wa-business-profile-manager

# Publish the Worker
wrangler publish

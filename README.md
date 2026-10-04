# Palermo Racing Diary: setup guide

This guide puts Palermo Racing Diary online for free. You need about an hour and a computer (setting up on a phone is fiddly). You'll set up four things, in this order:

| # | What | Where | Cost |
|---|---|---|---|
| 1 | A GitHub account (hosts the website) | github.com | Free |
| 2 | A Firebase project (sign-in and saved history) | console.firebase.google.com | Free "Spark" plan |
| 3 | A Gemini API key (the AI that watches the videos) | aistudio.google.com | Free tier |
| 4 | Upload the files and switch on the website | github.com | Free |

> **Staying free:** never add a credit card or turn on billing in Firebase ("Blaze" plan) or Google Cloud. Without billing, nothing can ever be charged. If you hit a free limit, the app just asks you to try again later.

Use a **personal Google account** (a Gmail address) for everything, not your work account.

---

## Step 1: Create a GitHub account

1. Go to **github.com** and click **Sign up**. Use your personal email.
2. Choose a **username** and write it down. Your website address will be:
   `https://palermoracing.github.io/soundness/`

---

## Step 2: Create the Firebase project

1. Go to **console.firebase.google.com** and sign in with your personal Google account.
2. Click **Create a project** (or **Add project**). Name it `palermo-gait-check`.
3. When asked about **Google Analytics**, switch it **off**. Click **Create project**, then **Continue**.
4. On the project home page, click the **web icon `</>`** ("Add an app", then "Web").
5. Nickname: `Palermo Racing Diary`. Leave "Firebase Hosting" **unticked**. Click **Register app**.
6. You'll see a code box containing `const firebaseConfig = { apiKey: "...", authDomain: "...", ... }`. Keep this page open, because you need those values in a minute.
7. Open the file **`config.js`** from the diary folder in Notepad (Windows) or TextEdit (Mac). Replace each `PASTE-HERE` with the matching value from Firebase. Keep the quote marks. Save the file.

   It should end up looking like this, but with your own values:
   ```js
   apiKey: "AIzaSyB...",
   authDomain: "palermo-gait-check.firebaseapp.com",
   projectId: "palermo-gait-check",
   storageBucket: "palermo-gait-check.firebasestorage.app",
   messagingSenderId: "1234567890",
   appId: "1:1234567890:web:abc123..."
   ```
8. Back in Firebase, click **Continue to console**.

These Firebase values are safe to put on the public website. Your data is protected by the sign-in and the team list you set up in Step 4.

---

## Step 3: Turn on Google sign-in

1. In the Firebase menu on the left, open **Build**, then **Authentication**, then click **Get started**.
2. On the **Sign-in method** tab, click **Google**, switch it to **Enable**, choose your email as the support email, and click **Save**.
3. Go to the **Settings** tab, then **Authorized domains**, then **Add domain**. Enter:
   `palermoracing.github.io` (your GitHub username, no `https://`, nothing after it). Click **Add**.

---

## Step 4: Create the database and the team list

1. In the left menu, open **Build**, then **Firestore Database**, then **Create database**.
2. Location: choose **australia-southeast1 (Sydney)**. This is the closest to New Zealand, and it can't be changed later.
3. Choose **Start in production mode**, then **Create**.
4. When it's ready, open the **Rules** tab. Delete everything in the box.
5. Open **`firestore.rules`** from the diary folder in Notepad or TextEdit. Change the two example emails to the Gmail addresses of everyone who should use the diary, starting with your own. Use lower case, keep each one in quotes, and separate them with commas:
   ```
   'kylie.example@gmail.com',
   'partner.example@gmail.com',
   'trainer.example@gmail.com'
   ```
   (No comma after the last one.)
6. Copy the whole file, paste it into the Rules box in Firebase, and click **Publish**.

Anyone whose email isn't on this list can't see or change anything, even if they have the link.

---

## Step 5: Get the Gemini API key (the AI)

1. Go to **aistudio.google.com** and sign in with the **same** personal Google account. Accept the terms if asked.
2. Click **Get API key**, then **Create API key**. When asked for a project, choose **palermo-gait-check** (your Firebase project).
3. Copy the key (it starts with `AIza…`) and keep it somewhere safe for Step 7. **Don't** put it in any of the files.
4. **Don't** set up billing. The free tier is enough for a stable.

**Recommended: lock the key to your website** so it can't be used anywhere else:

1. Go to **console.cloud.google.com**, and pick **palermo-gait-check** in the project selector at the top.
2. Open the menu (☰), then **APIs & Services**, then **Credentials**.
3. Under **API keys**, click the key that AI Studio created (often called "Generative Language API Key"). **Don't** change the one called "Browser key (auto created by Firebase)".
4. Under **Application restrictions**, choose **Websites**, click **Add**, and enter:
   `https://palermoracing.github.io/*`
5. Under **API restrictions**, choose **Restrict key**, tick **Generative Language API**, and click **Save**. It can take up to 5 minutes to take effect.

> Note: on the free tier, Google may use what you send (the horse videos and notes) to improve its products. Don't put people's personal details in the notes.

---

## Step 6: Put the website on GitHub

1. On **github.com**, click the **+** at the top right, then **New repository**.
2. Repository name: `soundness` (already created). Choose **Public** (free websites need a public repository). Click **Create repository**.
3. On the next page, click the link **uploading an existing file**.
4. Drag in **all the files** from the diary folder (not the folder itself): `index.html`, `app.js`, `styles.css`, `config.js` (the one you edited), `manifest.json`, `icon-192.png`, `icon-512.png`, `firestore.rules` and `README.md`.
5. Click **Commit changes**.
6. Go to the repository's **Settings** tab, then **Pages** (in the left menu).
7. Under **Build and deployment**, set Source to **Deploy from a branch**, Branch to **main**, and folder to **/ (root)**. Click **Save**.
8. Wait 1 to 3 minutes and refresh the page. A box appears saying "Your site is live at …". That's your link.

The code on GitHub is public, but it contains no secrets. The Gemini key is kept in your private database, not in the code.

---

## Step 7: First sign-in

1. Open your link: `https://palermoracing.github.io/soundness/`
2. Tap **Sign in with Google** and pick your personal account.
3. Tap **Settings** (top right), paste the **Gemini API key**, and tap **Test the key**. You should see "The key works…". Then tap **Save settings**. Everyone on the team now shares this key; nobody else needs to enter it.
4. Add your horses (mark each as **pacer** or **trotter**) and try a gait check with a short clip.

---

## Step 8: Add the team and put it on your phones

**Adding someone:** go to Firebase, then **Firestore Database**, then **Rules**. Add their Gmail address to the list and click **Publish**. Send them the link. They sign in with that Google account.

**Home-screen app:**
- **iPhone:** open the link in **Safari**, tap the **Share** button, then **Add to Home Screen**.
- **Android:** open the link in **Chrome**, tap the **⋮** menu, then **Add to Home screen** (or **Install app**).

---

## Troubleshooting

| Message or problem | Fix |
|---|---|
| "…isn't on the team list yet" | That email isn't in the Firestore rules, or has a typo or capital letters. Fix it in Step 4, then click Publish. |
| "This web address isn't on Firebase's authorised domains list" | Add `palermoracing.github.io` in Step 3, part 3. |
| "Almost there… hasn't been connected to Firebase" | `config.js` still has `PASTE-HERE` in it. Edit it on GitHub: click the file, then the pencil icon, paste the values, then **Commit changes**. |
| "Google refused the request" | The key's website restriction doesn't match. Check that it's exactly `https://palermoracing.github.io/*`, and wait 5 minutes. |
| "The free Gemini limit has been reached" | Wait a minute and try again. If it keeps happening, the daily limit is used up, so try tomorrow. |
| Model not found | Google renames models sometimes. The diary picks the newest free Flash model automatically. You can also type a model name in Settings. |
| The video won't play | On iPhone: **Settings → Camera → Formats → Most Compatible**. Or trim the clip in Photos first. |
| Upload is very slow | Film at **1080p** rather than 4K, and trim the clip to the useful 10 to 20 seconds in your Photos app before choosing it. |

**How videos are handled:** clips under about 14 MB are sent straight to the AI. Bigger clips are uploaded to Google for the analysis and deleted straight after. If that upload doesn't work, the app sends 16 still frames instead, which still works but is less accurate. Videos are never saved in your database. Only the report, your notes and 4 small snapshots are kept.

**Updating the app later:** upload the changed file(s) to the same GitHub repository with **Add file → Upload files**. Your saved horses and history stay in Firebase and aren't affected.

# Blue Jay Bookmarks (Android build)

Offline single-page app, wrapped with Capacitor. No CDN, no web font: Tailwind is compiled locally and icons are local SVG files.

## 1. Build the web files (needs internet once, on your computer)
```
npm install
npm test            # 23 unit tests
npm run build       # creates ./www  (compiled CSS + local SVG icons, no CDN)
```
Optional: put `small-icon.png` in `assets/` (header logo/favicon; hidden if missing).

## 2. Make the APK
```
npm run android:add     # once: creates ./android
npm run android:sync    # rebuild www and copy into Android project
npm run android:open    # opens Android Studio
```
In Android Studio: Build > Build APK(s) (or Generate Signed Bundle/APK for release). Needs JDK 17 and the Android SDK (Android Studio installs both).
Plugins used (already in package.json): Filesystem, Share, Browser, App. The app also works in a plain browser.

## 3. Sync (Settings > the cloud button in the header). All four work; pick one.
Merge rule: newest edit per bookmark wins; deletes are remembered (180 days); editing after a delete revives it.

**Shared file** - no account. On desktop Chrome/Edge it keeps a JSON file you choose (put it in Dropbox/Drive/Syncthing folder). On phones it uses pick/save, so you tap Sync to merge.

**Firebase** - Console: create project, Authentication > Email/Password on, create Firestore (production mode). Paste the Web API key and project ID in the app, enter email + password, "Create account" the first time. Rules:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

**Supabase** - Authentication > Email on. SQL editor:
```sql
create table public.bookmarks (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  id text not null,
  name text not null default '',
  url text not null default '',
  folder text not null default 'No Folder',
  tags jsonb not null default '[]',
  is_incognito boolean not null default false,
  is_favorite boolean not null default false,
  note text not null default '',
  date_added bigint not null default 0,
  updated_at bigint not null default 0,
  deleted boolean not null default false,
  primary key (user_id, id)
);
alter table public.bookmarks enable row level security;
create policy "own rows" on public.bookmarks for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
```
Paste Project URL + anon key in the app (the anon key is meant to be public; the policy protects data).

**Own server (WebDAV / Nextcloud)** - URL to a file, e.g. `https://cloud.example.com/remote.php/dav/files/USER/wayfinder.json`, plus username and an app password (Nextcloud: Settings > Security). Server must be HTTPS and allow CORS if used from a browser; the Android app is not limited by CORS. The password is stored on the device.

## Notes
- Import accepts Wayfinder JSON or browser bookmark HTML; it only adds/fills gaps, never overwrites or deletes, and can be undone.
- Duplicates: Exact = same page; Domain = near-identical pages on the same site (one-letter differences). Strict/Normal/Loose sets how close.
- Not tested against live Firebase/Supabase/WebDAV (only mocks) and not built into an APK here; do a first sync with a few test bookmarks.

## Hidden bookmarks (PIN vault)
Tap the header logo 3 times quickly. The first time you create a 4-12 digit PIN; after that you enter it to open the vault. Inside, the list shows only hidden bookmarks (search, folders and duplicate finder work on them too). Tap the logo 3 times again, press Lock, press Back, or leave the app to lock it.
Add a bookmark with "Hidden (PIN vault)" ticked, or select rows and press Hide / Unhide.
Honest limits: the PIN only gates the screen. Hidden bookmarks are not encrypted, so they still appear in export files, device storage and your sync server. A forgotten PIN can't be recovered (clearing app data resets it and unhides nothing; the bookmarks remain hidden until a new PIN is set).

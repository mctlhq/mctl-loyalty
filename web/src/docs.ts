// Static help/guide. Makes NO API calls, so it renders both inside Telegram
// (/help) and in a plain browser (/docs, shareable link).

export function renderDocs(root: HTMLElement): void {
  root.innerHTML = `
    <div class="card">
      <h2>MCTL Rewards — guide</h2>
      <p class="muted">A Telegram loyalty program. Earn points across partner places and spend them
      on rewards. One balance works everywhere in the community.</p>
    </div>

    <div class="card">
      <h3>For customers</h3>
      <ol>
        <li>Open the bot and tap <b>Open</b> to launch the app.</li>
        <li>Show your personal <b>QR code</b> to the staff. It rotates every ~30 seconds and is
            single-use — nobody can reuse a screenshot of it.</li>
        <li>Points land on your single <b>balance</b> and you get a Telegram notification.</li>
        <li>Open <b>Rewards</b> and tap a reward to redeem it (points are reserved immediately).
            Show the confirmation to staff to receive it.</li>
        <li><b>History</b> lists every earn and spend.</li>
      </ol>
      <img class="shot" src="/screenshots/profile.png" alt="Customer profile with balance and QR" loading="lazy" />
    </div>

    <div class="card">
      <h3>For staff (scanners)</h3>
      <ol>
        <li>Open the app and go to <b>Admin panel</b>. You only see the merchant you work for.</li>
        <li>Pick the <b>merchant</b> (if you have one, it is preselected) and tap <b>Scan QR</b>.</li>
        <li>Scan the customer's QR and choose the <b>accrual rule</b> (e.g. Visit, Purchase).</li>
        <li>Points are awarded instantly. Daily limits per rule prevent farming.</li>
        <li>Under <b>Redemption requests</b> you can <b>Fulfill</b> or <b>Cancel</b> a customer's
            redemption (cancel returns the points).</li>
      </ol>
      <img class="shot" src="/screenshots/admin.png" alt="Staff / admin panel" loading="lazy" />
    </div>

    <div class="card">
      <h3>For cafe owners (merchant admins)</h3>
      <ol>
        <li>In the <b>Admin panel</b> open the <b>Staff</b> section for your place.</li>
        <li>Ask your employee to open the bot and copy their <b>ID</b> from their profile screen
            (the <code>ID: …</code> line with a Copy button).</li>
        <li>Enter that <b>telegram_id</b> and tap <b>Add</b> to make them a scanner. Remove them
            anytime.</li>
        <li>One employee can belong to <b>only one</b> merchant.</li>
      </ol>
    </div>

    <div class="card">
      <h3>For the platform owner (super-admin)</h3>
      <p>Create merchants, accrual rules and the rewards catalog, and assign each merchant's
      admin. Super-admins can manage staff for any merchant.</p>
    </div>

    <div class="links">
      <a class="link" href="/app">← Back to app</a>
    </div>
  `;
}

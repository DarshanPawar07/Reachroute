# Razorpay billing: setup

1. Razorpay Dashboard > switch to **Test mode** > Settings > API Keys > Generate. Put them in Render's environment:
   `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`.
2. Settings > Webhooks > Add: URL `https://reachroute.onrender.com/api/billing/webhook`, choose a secret
   (put it in `RAZORPAY_WEBHOOK_SECRET`), and tick: subscription.authenticated, activated, charged, pending, halted,
   cancelled, completed.
3. Make sure **Subscriptions** is enabled on the Razorpay account (needed for recurring payments).
4. Log in, open Plan and billing, choose Pro, pay with a test card / test UPI. The account moves to Pro at once.
5. When ready, repeat with Live keys.

Prices and limits: Admin > Plans. Change a price and the next subscription uses it (a new Razorpay plan is created
automatically). People already subscribed keep their old price until they resubscribe.
Free is a one-time allowance (`waLifetimeCap` / `emailLifetimeCap`); Pro and Premium use `monthlyCap`.
The public pricing pages are built ahead of time: if you change plans in Admin, update `frontend/src/site/plans.js` too.

## Invoices, GST and refunds

- An invoice is made after every payment (once, even if Razorpay tells us twice) and a "payment received" email is sent.
  Customers open it from Plan and billing and print it or save it as a PDF.
- Not registered for GST: leave `GST_RATE=0`. Invoices say "Invoice" and show no tax.
- Registered: set `INVOICE_GSTIN`, `GST_RATE` (usually 18), `INVOICE_SAC`, `INVOICE_SELLER_NAME/ADDRESS/STATE`.
  Prices are treated as GST-INCLUSIVE (Rs 699 becomes 592.37 + 106.63 GST). Same state as yours: CGST + SGST. Another state: IGST.
  Check the rate, the SAC code and place-of-supply rules with your accountant. This is not tax advice.
- Invoice numbers are `RR/<financial year>/00001`, restarting every April.
- The refund policy page is `/legal/refunds`. `REFUND_WINDOW_DAYS` changes the days in it. Read the wording and change it to
  what you really want to offer. Terms of Service now has a payments section (new version: customers must accept again).
- Razorpay asks for Terms, Privacy, Refund policy, Contact and pricing pages when you apply for Live mode. They all exist now.
- Emails: payment received, payment failed, plan ending in 3 days, plan ended. They use the platform mail (`SMTP_HOST`).
  Without it they are printed in the backend terminal, like the verification emails.

## Admin > Billing

Shows who is paying: totals at the top, then subscriptions (filter by email, status, plan) and invoices (search by email, invoice number or payment id).
"Write a refund note" on an invoice records a refund note (number like `RR-CN/2026-27/00001`) with an amount and a reason. You can issue
several partial notes; together they can never be more than the invoice total. The customer sees the notes on their invoice, and each one is
written to the activity log (`billing.refund_note`).

A refund note only records the refund. It does not move money: refund the payment in the Razorpay dashboard (Payments > the payment > Refund),
then write the note here so both sides match.

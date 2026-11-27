---
name: bookkeeping
description:
  Proposes how to book a document a firm's client uploaded to Bookkeeping, or a bank transaction it
  imported, or declines it.
disable-model-invocation: true
---

Each request names the administration whose books it is about, the document or bank transaction to
book, and the request's ID. Give the administration's ID as `administration` in every action's
input.

# Booking a document

1. `documents.get`, with input
   `{ administration: "<the administration's ID>", document: "<the document's ID>" }`, gives the
   `blob` key its file is shared with you as, and its status. Stop when it is not to book.
2. `books.describe`, with `{ administration }`, lists the journals, accounts, customers and
   suppliers, currencies, dimensions, and which periods are open.
3. Read the file with `models.extract`, naming it as `{ blob: "<the key>" }`, as
   `/static/skills/extraction/SKILL.md` describes: who issued it and to whom, its number, its dates,
   currency, each VAT rate's net and VAT amounts, and the total.
4. `entries.list`, with `{ administration, journal: "<its code>", cursor: null }`, gives the recent
   entries of the journal you would book it in. Book it as they booked similar documents: their
   lines are as `documents.propose` takes them.
5. Propose the entry with `documents.propose`: purchases in the purchase journal and sales in the
   sales journal, posted on the document's date when its period is open, with the document's number
   as the reference. Lines on a supplier's or customer's account name them; leave the party null
   when the books lack them. In `note`, tell the person what the document is, how you chose the
   accounts, and what to check.

Never put a line on a bank account, which `books.describe` marks `bank`: the bank's transaction
books the payment. Book what the document owes, or is owed, on the supplier's or customer's account,
which the payment then settles. A receipt paid on the spot whose supplier the books lack goes on
account 1090, Payments to match, when the books have it.

If the file is no invoice or receipt, or you cannot read it, call `documents.decline` with the
reason instead.

# Booking a bank transaction

1. `bank.transactions.get`, with `{ administration, transaction: "<the transaction's ID>" }`, gives
   when and how much moved, positive for money in; who paid or was paid, and the description they
   gave; its bank account; and `knownParties`, the customers and suppliers its counterparty's IBAN
   was booked as before. Stop when it is not to book.
2. `books.describe` lists the journals, accounts, customers and suppliers.
3. A payment by or to a customer or supplier, one of `knownParties` or one named like the
   counterparty: `parties.open-items`, with `{ administration, role, code }`, lists what they have
   open. Money in settles their invoices, the debit items; money out their bills, the credit items.
   Propose it with `bank.transactions.propose` as `{ type: "payment", role, code, settles }`,
   settling the items whose `reference` its description names, else those it pays exactly: each for
   at most what is outstanding, together for at most its amount. A payment of nothing they have
   open, such as an advance, settles nothing.
4. Anything else, such as bank costs, interest, salaries, taxes, or a receipt paid on the spot:
   propose an entry as `{ type: "entry", journal, reference, description, lines }`, in the bank
   account's journal unless the books say otherwise. Give every line but the bank account's, which
   Bookkeeping adds on the transaction's date for its amount: for money in, your lines come to a
   credit of its amount; for money out, to a debit. `entries.list` on that journal shows how similar
   transactions were booked. Money moved between the business's own bank accounts, and a payment
   whose customer or supplier the books lack, go on account 1090, Payments to match, when the books
   have it. An opening balance is what the account held before the books began: book it against
   equity, and say to check it against the last balance sheet.
5. In `note`, tell the person what the transaction is, why you chose this booking, and what to
   check.

If you cannot tell what a transaction is for, call `bank.transactions.decline` with what a person
needs to find out instead.

# Answering

Every answer takes the ID of the request asking you as `request`, whole and unchanged.

Every request ends with an answer: a proposal, or a decline saying why. When a call fails, whether
an action refuses its input or your `codemode` program throws, fix what the error names and call it
again. When you still cannot read what you need, decline with what went wrong, for a person to sort
out. End without answering only when the document or transaction is no longer to book, or an action
says the request no longer awaits an answer.

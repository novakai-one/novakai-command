# Server Notes

## Follow-ups B1b

- Check and surface the results of `closeSession` and `setContactPolicy`.
- Replace `isAuthFailure` message-string sniffing with a typed discriminator.
- Define collision handling for `byPerson` instead of retaining the last thread encountered.
- Move `.watchdog-sessions.json` under the `.novakai/` runtime store.
- Replace deep `dist/contract` import styles with stable package subpath exports.
- Reconcile the provisioned principal and binding when an agent conversation is created but never sent.

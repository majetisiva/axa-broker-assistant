# Contract with the existing Java APIs

The assistant calls the same Java endpoints the Angular webforms call when the broker presses **TO CONFIRM**.
Set `BACKEND_BASE_URL` to the API gateway. Each catalogue action names its endpoint in `submission.endpoint`.

## Request sent by the assistant

`POST {BACKEND_BASE_URL}{submission.endpoint}` with `Content-Type: application/json`:

```json
{
  "requestId": "REQ-20261119-3F2A1C",
  "schemaVersion": "axa-be/broker-request/1.0",
  "action": { "id": "motor_suspension", "version": "1.0.0", "portalRoute": "bss/suspension" },
  "channel": "broker-chat",
  "language": "fr",
  "broker": { "producerNumber": "1055500", "cifNumber": "00012345", "difNumber": "0012345" },
  "fields": {
    "contractNumber": "622382121",
    "suspensionDate": "2026-11-20",
    "bankAccount": "BE68 5390 0754 7034",
    "noticeOfDeletion": { "fileId": "F-9c1e2a7b3d", "name": "plate.pdf", "size": 48211, "mime": "application/pdf" }
  },
  "documents": [ { "fieldId": "noticeOfDeletion", "name": "plate.pdf", "mime": "application/pdf", "contentBase64": "..." } ]
}
```

`broker.cifNumber` and `broker.difNumber` come from the portal session (the webforms require them). The assistant does not
send a request when one is missing.

Dates are `DD/MM/YYYY` in the request JSON, except fields marked `"submitAs": "iso-date"` in the catalogue
(the suspension date), which the submitter sends as `YYYY-MM-DD`, like the webform.

| Webform | Endpoint (placeholder) | Fields |
|---|---|---|
| Suspension | `/policy-servicing/suspension` | `contractNumber`, `suspensionDate`, `bankAccount` (optional), `noticeOfDeletion` |
| BrokerMandate | `/policy-servicing/broker-mandate` | `contractNumbers[]`, `producerNumber`, `noticeOfChange` |
| Renon | `/policy-servicing/cancellation` | `contractNumber`, `cancellationLetter` |
| Domiciliation with fractionment | `/policy-servicing/direct-debit` | `contractNumber`, `bankAccount`, `holderIsPolicyholder` (yes/no), `sepaMandate`, `changeSplit` (yes/no), `newSplit` (annual/semiannual/quarterly/monthly, when `changeSplit` = yes) |
| CopieContract | `/policy-servicing/contract-copy` | `contractNumber` |

`language` (`en`, `fr` or `nl`) is the broker's conversation language, also sent as the `Accept-Language` header.
Error messages in 422 responses should be in that language: the assistant shows them to the broker as they are.

`documents` is only included when `BACKEND_SEND_FILES=true`. If the Java API expects `multipart/form-data`
(like the webform upload), adapt `server/submitter.js`. Only that file needs to change.

If the Java DTOs use other field names, add a mapping step in the submitter, or rename the
field `id`s in the catalogue so they match the DTO.

## Responses the assistant understands

| HTTP | Body | Assistant behaviour |
|---|---|---|
| 200 | `{ "status": "COMPLETED", "reference": "...", "task": { "system": "GD", "id": "...", "status": "closed" } }` | Shows STP success with the closed task |
| 200 | `{ "status": "ROUTED", "reference": "...", "mail": { "to": "...", "reference": "..." } }` | Shows "sent to a handler" (non-STP) |
| 422/400 | `{ "message": "...", "errors": [ { "field": "contractNumber", "message": "Contract not found" } ] }` | Marks those fields invalid and asks only for them again; everything else is kept |
| other | any | Tells the broker nothing was sent and offers a retry |

Business validation stays in the Java back end. The assistant only checks formats so it can guide the dialogue.

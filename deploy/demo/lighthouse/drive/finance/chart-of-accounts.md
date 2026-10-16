# Chart of accounts

Lighthouse books in GBP. A USD line is converted at the month's rate the owner sets on the schedule (use
0.79 for September 2026 unless told otherwise) and the original amount is kept in a note.

| Code | Account                 | What goes here                                                 |
| ---- | ----------------------- | -------------------------------------------------------------- |
| 4000 | Revenue                 | Customer invoices paid                                         |
| 5000 | Cloud infrastructure    | Clusters, storage, networking                                  |
| 5100 | Model usage             | Model API usage by any provider                                |
| 6000 | Software subscriptions  | Seats and plans for tools the team uses                        |
| 6100 | Contractors             | Freelancers and agencies                                       |
| 6200 | Marketing               | Ads, swag, sponsorships                                        |
| 6300 | Travel                  | Trains, flights, hotels, taxis for customer or event travel    |
| 6400 | Events                  | Booths, tickets, event deposits                                |
| 6500 | Office and team         | Office supplies, team meals                                    |
| 6600 | Security and compliance | Audits, penetration tests, certifications                      |
| 6900 | Bank fees               | Bank and payment charges                                       |
| 9999 | Needs a person          | Anything that does not fit, looks personal or looks duplicated |

A line goes to 9999 with a one-line reason rather than into the nearest account. Refunds book against
the account of the original charge.

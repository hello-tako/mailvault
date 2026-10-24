# Zones xoá ngày 2026-10-01 — snapshot để đối chiếu nếu cần dựng lại

Người ra lệnh: chủ tài khoản (tin nhắn: "xoá hết … cả trên cloudflare lẫn mailvault").
Phạm vi: 20 zone Cloudflare + 20 row `domains` trong D1 production (mail-vault-db).
Điều kiện đã kiểm tra trước khi xoá: mỗi domain có **0 alias và 0 thư** trong MailVault.

Không có gì bị xoá ở registrar: đăng ký của các tên miền này nằm ở IONOS (không phải
Cloudflare Registrar), nên chúng vẫn tồn tại cho tới ngày hết hạn ghi dưới đây — chỉ DNS
của Cloudflare và hồ sơ trong MailVault là bị gỡ.

Ghi chú định dạng: các bản ghi DKIM `cf2024-1._domainkey.*` là khoá công khai do Cloudflare
Email Routing sinh ra; ở đây chỉ giữ 40 ký tự đầu + độ dài, vì dựng lại = bật lại Email
Routing cho zone (khoá mới sẽ được cấp). Những bản ghi khác giữ nguyên văn.

| domain | zone id | hết hạn (registrar) | ghi chú bản ghi |
|---|---|---|---|
| vnecs.info | fb61e5aac7c0bb4fbecf863dc6815b5f | 2026-10-09 (IONOS SE) | A 74.208.236.104 proxied, AAAA 2607:f1c0:100f:f000::200, CNAME autodiscover→adsredir.ionos.info, CNAME _domainconnect→_domainconnect.ionos.com, MX mx00/mx01.ionos.com, NS ui-dns.*, TXT "v=spf1 include:_spf-us.ionos.com ~all" (11 records) |
| vnecs.store | 38d8b2600008c77f5ef35990f03f942c | 2026-10-09 (IONOS SE) | A apex/www/admin → 158.51.108.165 (dns-only), MX route1-3.mx.cloudflare.net, DKIM cf2024-1 (40 ký tự đầu "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAi" / ~360) (7 records) |
| asivn.info | efa30cd40b64465d2c14c65d595542ce | 2026-10-19 (IONOS SE) | A 74.208.236.137 proxied, AAAA, CNAME autodiscover/_domainconnect, MX route1-3, NS ui-dns.*, SPF include:_spf-us.ionos.com ~all, google-site-verification VLikYS-RXTyi_zL1hFy9_fYABd9SzBPFcckIqCMeEjE, DKIM cf2024-1 (14 records) |
| asivn.online | d4e2f3f6f647d0bfe811eeb3dc98623b | 2026-10-19 (IONOS SE) | A 74.208.236.13 proxied, AAAA, CNAME ×2, MX route1-3, NS ×4, SPF include:_spf-us.ionos.com include:_spf.google.com ~all, google-site-verification zBvZpLD1biRZ2MJTrfmIr8suQz0EExy_vd5X1Tvfrw4, DKIM (14 records) |
| asivn.org | 2ac825b1a06798db08153455b47b41be | 2026-10-19 (IONOS SE) | A 74.208.236.201 proxied, AAAA, CNAME ×2, MX route1-3, NS ×4, SPF ionos+google ~all, google-site-verification JcJ7PHNuuMI00yBYPJJMj88RWW7N8VuMaW9AsYBO5Bw, DKIM (14 records) |
| asivn.store | ff33654be6dcc2886243204676a11342 | 2026-10-19 (IONOS SE) | A 74.208.236.185 proxied, AAAA, CNAME ×2, MX route1-3, NS ×4, SPF ionos+google ~all, google-site-verification RdP81svMfeSK_igP6OAfmPz8twj2Xlv7ecEssBzfmUg, DKIM (14 records) |
| logivn.info | 2ac1e6446bab64a91a62acabc974e326 | 2026-10-19 (IONOS SE) | MX route1-3.mx.cloudflare.net, DKIM cf2024-1, SPF "v=spf1 include:_spf.google.com -all", google-site-verification QGbRNTUIOtYH62dYfsrO4rRE5jtJcTLVwYB3SIPJdtg (6 records) |
| logivn.org | eb5fd804764b2187348f96af83213cb5 | 2026-10-19 (IONOS SE) | MX route1-3, DKIM, SPF google -all, google-site-verification 3nJyLKGIFWBboH7HDIFBrMRvClShDujOceJ9Pp4mBKE (6 records) |
| logivn.store | 9d29a689eba4c3dca69ae8ff5368b722 | 2026-10-19 (IONOS SE) | MX route1-3, DKIM, SPF google -all, google-site-verification 4p0jwJb9VwkQxoFHuA_-ldwlz8urRW_XYTDUpb2zJJI (6 records) |
| antivn.com | 303d5b9e15c3545cef0c801d586ebcc1 | 2026-10-20 (IONOS SE) | A 74.208.236.158 proxied, AAAA, CNAME ×2, MX route1-3, NS ×4, SPF ionos+google ~all, google-site-verification EPUX9vnpoB6HGDI_mnTC5EIoieBe7YpWrvBWjp2LRBA, DKIM (14 records) |
| antivn.info | 3d7acc397b95e3f29f0490a0db0066e0 | 2026-10-20 (IONOS SE) | A 74.208.236.9 proxied, AAAA, CNAME ×2, MX route1-3, NS ×4, SPF ionos ~all, DKIM (13 records) |
| antivn.org | 115de31db44a055bdbb7c38101954f39 | 2026-10-20 (IONOS SE) | A 74.208.236.4 proxied, AAAA, CNAME ×2, MX route1-3, NS ×4, SPF ionos ~all, DKIM (13 records) |
| antivn.store | 3228ed3c94b39d4cf88c9065845ccd39 | 2026-10-20 (IONOS SE) | A 74.208.236.100 proxied, AAAA, CNAME ×2, MX route1-3, NS ×4, SPF ionos+google ~all, google-site-verification cg5eeCQHcakScXAWzRRASMgJRqgA9GS7xf…, DKIM (14 records) |
| abitovn.info | e1ac26fc64ab745a2f3d187dc02f201d | 2026-10-21 (IONOS SE) | A 74.208.236.81 proxied, AAAA, CNAME ×2, MX route1-3, NS ×4, SPF ionos ~all, DKIM (13 records) |
| abitovn.org | 328d9615bf74b2060885d77e5f172f01 | 2026-10-21 (IONOS SE) | A 74.208.236.211 proxied, AAAA, CNAME ×2, MX route1-3, NS ×4, SPF ionos ~all, DKIM (13 records) |
| abitovn.store | 15c2a3be5cd9c7354c1a177a9e2ac928 | 2026-10-21 (IONOS SE) | A 74.208.236.246 proxied, AAAA, CNAME ×2, MX route1-3, NS ×4, SPF ionos ~all, DKIM (13 records) |
| antexvn.com | a7879eef959e6783799ac7cefee33844 | 2026-10-21 (IONOS SE) | A 74.208.236.176 proxied, AAAA, CNAME ×2, MX route1-3, NS ×4, SPF ionos ~all, DKIM (13 records) |
| antexvn.info | 30da795bd6b38dcd6f4904c9b801705c | 2026-10-21 (IONOS SE) | A 74.208.236.54 proxied, AAAA, CNAME ×2, MX route1-3, NS ×4, SPF ionos ~all, DKIM (13 records) |
| antexvn.org | f35271aa13497b929c744aec5ab95cc7 | 2026-10-21 (IONOS SE) | A 74.208.236.130 proxied, AAAA, CNAME ×2, MX route1-3, NS ×4, SPF ionos ~all, DKIM (13 records) |
| antexvn.store | 5b9f733fed9a1f1b88cf6e99c49a4cc7 | 2026-10-21 (IONOS SE) | A 74.208.236.27 proxied, AAAA, CNAME ×2, MX route1-3, NS ×4, SPF ionos ~all, DKIM (13 records) |

Không nằm trong danh sách này (vẫn còn zone + row MailVault): vnecs.com, vnecs.org, logivn.com,
abitovn.com, tungjp.store, taphoanhatung.com, omnipos.tech, tung.codes, datlichngay.com/.net,
thuhanghair.com, thiepmoidamcuoi.com, chophanmem.com, doanthuonghighschool.com, selinow.com,
tungjpstore.net, fball.vn.

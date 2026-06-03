-- Package catalogue — snapshot of project-pricing/bedrock-pricing.md (dated 2026-05-28).
-- Bedrock stays source of truth; re-sync on price change (drift guard 7).
insert into public.packages (name, category, standard_cents, member_cents, sort) values
  ('SBH Walk-in',                   'SBH',   5500,   3850, 10),
  ('SBH Day Pass',                  'SBH',   6800,   4760, 11),
  ('Half-Price Off-Peak Walk-in',   'SBH',   2750,   null, 12),
  ('SBH 5-Pack',                    'SBH',  20500,  16400, 20),
  ('SBH 10-Pack',                   'SBH',  38000,  30400, 21),
  ('SBH 20-Pack',                   'SBH',  58000,  46400, 22),
  ('SBH 50-Pack',                   'SBH', 125000, 100000, 23),
  ('SBH Full Unlimited (mo)',       'SBH',  37500,   null, 30),
  ('SBH Off-Peak Unlimited (mo)',   'SBH',  20000,   null, 31),
  ('SBH Membership Lite (mo)',      'SBH',  15000,   null, 32),
  ('Try Everything',                'Promo', 15800,  null, 40),
  ('SBH First Timer',               'Promo',  9900,  null, 41),
  ('SBH Off-Peak Trial',            'Promo', 12500,  null, 42),
  ('20-Pack (Trial Rate)',          'Promo', 38800,  null, 43),
  ('10-Pack (Trial Rate)',          'Promo', 25000,  null, 44),
  ('Red Light Therapy (single)',    'RLT',   5500,   3850, 50),
  ('RLT 10-Pack',                   'RLT',  19900,  15900, 51),
  ('RLT 20-Pack',                   'RLT',  34900,  27900, 52),
  ('RLT 50-Pack',                   'RLT',  74900,  59900, 53),
  ('RLT 2-Week Unlimited',          'RLT',  19900,  15900, 54),
  ('Hyperbaric Oxygen (single)',    'HBOT', 15000,  10500, 60),
  ('HBOT 5-Pack',                   'HBOT', 38800,  31000, 61),
  ('HBOT 10-Pack',                  'HBOT', 70000,  56000, 62)
on conflict do nothing;

begin;

create temporary table opening_balance_candidates (
  transaction_id uuid primary key,
  account_name text not null,
  original_date date not null,
  effective_date date not null,
  original_type text not null,
  amount_minor bigint not null
) on commit drop;

insert into opening_balance_candidates
  (transaction_id, account_name, original_date, effective_date, original_type, amount_minor)
values
  ('a54ea6d7-2c5a-4b03-ad68-1870f96feaf6', 'Assurance Vie',            '2022-10-01', '2023-02-05', 'income',  435924),
  ('7b869b6a-0121-4831-9f07-85eb22e04f18', 'BBVA',                     '2022-10-01', '2022-10-01', 'income',  234988),
  ('81103753-6d82-4237-9646-e127e8a27a08', 'BoursoBank',               '2022-10-01', '2022-10-01', 'income',   72954),
  ('a3667864-ea0d-4faa-90b0-cfe54dcb5d85', 'Cash',                     '2022-10-01', '2022-10-01', 'income',   19244),
  ('1fb64791-69e7-45d8-9688-6dc3d4939318', 'Degiro',                   '2022-10-01', '2022-10-01', 'income', 4101478),
  ('a8936b20-7d76-4a9d-a7f1-e859d82e3af0', 'ING',                      '2022-10-01', '2022-10-01', 'income',  118205),
  ('21477e21-2bdd-488c-8b18-98249e9f2546', 'LDD',                      '2022-10-01', '2022-10-01', 'income', 1200000),
  ('5977f656-ac06-4e91-9b61-1db5e47a1640', 'Livret A',                 '2022-10-01', '2022-10-01', 'income',    1010),
  ('8d304120-578f-4f7f-bc29-61cc0489f837', 'Apartment SE',             '2022-12-31', '2022-12-31', 'income', 366000000),
  ('1214f2f0-dc60-4893-827f-bd25b9e32082', 'Bolån',                    '2022-12-31', '2022-12-31', 'expense', 281300000),
  ('efdbcd7c-da98-4fad-bb8d-106a0e9dba11', 'Länsförsäkringar pension', '2023-01-01', '2023-01-01', 'income',  3724300),
  ('d3dfe815-4c5b-4c81-af4c-bae978770736', 'Nordnet KF',               '2023-01-01', '2023-01-01', 'income', 65327800),
  ('06b413ce-2fc0-496f-b8d6-2c068b49a1d9', 'Nordnet pension',          '2023-01-01', '2023-01-01', 'income', 26912300),
  ('bd3b1b80-5005-4c4f-9036-ab9d48128b7c', 'Premiepension',            '2023-01-01', '2023-01-01', 'income', 12801600),
  ('bd21639d-bb7d-457f-b92b-9459af664eba', 'SEB Företag',              '2023-01-01', '2023-01-01', 'income', 53974574),
  ('4ed16fd6-a8f8-4225-ade8-e81cacdf3588', 'SEB pension',              '2023-01-01', '2023-01-01', 'income', 18580800),
  ('ec997cff-c52d-4d0f-a837-6166faff9acf', 'Transformia pension',      '2023-01-01', '2023-01-01', 'income', 11766500),
  ('cab28b3b-b727-4065-8291-de557e3d281b', 'Inkomstpension',           '2023-01-02', '2023-01-02', 'income', 69721900),
  ('9297e908-bb91-44b9-b129-f43eeb90c044', 'Handelsbanken',            '2023-01-31', '2023-01-31', 'income',  7371349);

do $$
declare
  matching_rows integer;
begin
  select count(*) into matching_rows
  from opening_balance_candidates candidate
  join public.accounts account on account.name = candidate.account_name
  join public.transactions transaction
    on transaction.id = candidate.transaction_id
   and transaction.account_id = account.id
   and transaction.transaction_date = candidate.original_date
   and transaction.transaction_type = candidate.original_type
   and transaction.amount_minor = candidate.amount_minor;

  if matching_rows <> 19 then
    raise exception 'Expected 19 unchanged opening-balance candidates, found %', matching_rows;
  end if;
end $$;

update public.transactions transaction
set transaction_type = 'opening_balance',
    transaction_date = candidate.effective_date,
    period_id = period.id,
    category_id = null,
    payee_id = null,
    payee_name = null,
    destination_account_id = null,
    destination_amount_minor = 0,
    updated_at = now()
from opening_balance_candidates candidate
join public.accounts account on account.name = candidate.account_name
join public.periods period
  on period.workspace_id = account.workspace_id
 and period.year = extract(year from candidate.effective_date)::integer
 and period.month = extract(month from candidate.effective_date)::integer
where transaction.id = candidate.transaction_id
  and transaction.account_id = account.id;

do $$
begin
  if (select count(*) from public.transactions where id in (select transaction_id from opening_balance_candidates) and transaction_type = 'opening_balance') <> 19 then
    raise exception 'Not all opening-balance candidates were converted';
  end if;
end $$;

commit;

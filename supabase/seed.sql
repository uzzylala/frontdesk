-- Frontdesk demo seed data — phase 2
-- Run after schema.sql, in the Supabase SQL editor. Safe to re-run: each
-- customer is only seeded if a conversation with that name doesn't already
-- exist, so running this twice won't duplicate conversations.

do $$
declare
  v_conversation_id uuid;
  v_customer record;
begin
  for v_customer in
    select * from (values
      ('Amara O.', 'Hi, I was charged twice for my last order.'),
      ('Deji K.', 'Quick question about the return policy.'),
      ('Priya S.', 'Is there a way to change my shipping address?'),
      ('Tom W.', 'The app keeps crashing when I try to check out.'),
      ('Grace L.', 'Do you offer student discounts?')
    ) as t(customer_name, first_message)
  loop
    if not exists (
      select 1 from conversations where customer_name = v_customer.customer_name
    ) then
      insert into conversations (customer_name)
      values (v_customer.customer_name)
      returning id into v_conversation_id;

      insert into messages (conversation_id, sender_type, body)
      values (v_conversation_id, 'customer', v_customer.first_message);
    end if;
  end loop;
end $$;

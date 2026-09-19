-- Removes the leftover messages from the Phase 2/3/4 browser verification runs
-- so the seeded demo conversations read like real ones.
--
-- Run in the Supabase SQL editor. Idempotent: a second run deletes nothing.
-- The patterns are anchored to the exact prefixes the verification scripts
-- used, so a genuine message can't match by accident.

-- 1. Preview — what is about to be deleted.
select c.customer_name, m.sender_type, m.body
from messages m
join conversations c on c.id = m.conversation_id
where m.body like 'crosstalk-check-%'
   or m.body like 'live-unread-test-%'
order by c.customer_name, m.created_at;

-- 2. Delete.
delete from messages
where body like 'crosstalk-check-%'
   or body like 'live-unread-test-%';

-- 3. Check — should return zero rows.
select count(*) as leftover_test_messages
from messages
where body like 'crosstalk-check-%'
   or body like 'live-unread-test-%';

-- Also from those runs: the widget demo's default visitor. Any conversation
-- a browser test opened via the demo host page is named 'Demo Visitor' (the
-- seeded conversations are not). Messages go with it (on delete cascade).
-- Uncomment to remove:
--
-- delete from conversations where customer_name = 'Demo Visitor';

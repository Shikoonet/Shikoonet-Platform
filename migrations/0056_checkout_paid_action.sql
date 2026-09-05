-- 0056 — one unmistakable action at the end of a card invoice.
--
-- The checkout used to end with two half-width buttons: «پرداخت کردم» and
-- «بازگشت به منو». The persistent keyboard below the chat now owns navigation,
-- so the second button is redundant and makes the action that actually finishes
-- checkout harder to see and tap.
--
-- A saved keyboard replaces the code's default wholesale. Updating only the
-- TypeScript default would therefore leave every shop that had ever customised
-- this screen on the old layout. Move its required action onto a fresh last row
-- and paint it green here as well, while leaving its chosen label untouched.

BEGIN;

DELETE FROM bot_keyboard_buttons
 WHERE menu = 'checkout'
   AND action = 'menu';

UPDATE bot_keyboard_buttons AS paid
   SET row_index = (
         SELECT COALESCE(MAX(other.row_index), -1) + 1
           FROM bot_keyboard_buttons AS other
          WHERE other.menu = 'checkout'
            AND other.action <> 'paid'
       ),
       col_index = 0,
       style = 'success'
 WHERE paid.menu = 'checkout'
   AND paid.action = 'paid';

COMMIT;

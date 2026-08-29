<?php
ini_set('error_log', 'error_log');
date_default_timezone_set('Asia/Tehran');
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../botapi.php';
require_once __DIR__ . '/../panels.php';
require_once __DIR__ . '/../function.php';
require __DIR__ . '/../vendor/autoload.php';
$ManagePanel = new ManagePanel();
$setting = select("setting", "*");
$textbotlang = languagechange();
// Card-to-card invoices expire after 30 minutes; everything else keeps the old
// 24h window, because a crypto gateway can legitimately take hours to confirm.
//
// 30 minutes and not 10: measured across 4266 real paid card-to-card invoices,
// a 10-minute window would have expired 280 of them (6.6%) after the customer
// had already sent the money. 30 minutes costs 2.1%.
//
// The card lease is still 600s, so between minute 10 and minute 30 the card may
// already be serving someone else. Closing that gap means raising the lease to
// 30 minutes too, which the pool cannot take yet: peak concurrent leases at a
// 30-minute lease is 14 and there are 10 active cards.
//
// date() is safe here: line 3 of this file pins the timezone to Asia/Tehran,
// which is the timezone Payment_report.time is written in.
$cart_cutoff  = date('Y/m/d H:i:s', time() - 1800);
$other_cutoff = date('Y/m/d H:i:s', time() - 86400);
$stmt = $pdo->prepare(
    "SELECT * FROM Payment_report
     WHERE payment_Status = 'Unpaid'
       AND ((Payment_Method = 'cart to cart' AND time < :cart)
         OR (Payment_Method <> 'cart to cart' AND time < :other))"
);
$stmt->execute([':cart' => $cart_cutoff, ':other' => $other_cutoff]);

while ($result = $stmt->fetch(PDO::FETCH_ASSOC)) {
    $status_var = [
        'cart to cart' =>  $textbotlang['textbot']['cartToCart'],
        'aqayepardakht' => $textbotlang['textbot']['aqayePardakht'],
        'zarinpal' => $textbotlang['textbot']['zarinPal'],
        'plisio' => $textbotlang['textbot']['nowPayment'],
        'arze digital offline' => $textbotlang['textbot']['nowPaymentTron'],
        'Currency Rial 1' => $textbotlang['textbot']['iranPay2'],
        'Currency Rial 2' => $textbotlang['textbot']['iranPay3'],
        'Currency Rial 3' => $textbotlang['textbot']['iranPay1'],
        'Currency Rial tow' => $textbotlang['hardcoded']['gatewayRialName1'],
        'Currency Rial gateway3' => $textbotlang['hardcoded']['gatewayRialName2'],
        'perfect' => $textbotlang['hardcoded']['gatewayPerfectMoney'],
        'paymentnotverify' => $textbotlang['textbot']['paymentNotVerify'],
        'Star Telegram' => $textbotlang['textbot']['starTelegram'],
        'nowpayment' => $textbotlang['textbot']['cryptoPayment']
        
    ][$result['Payment_Method']];
    $textexpire = sprintf($textbotlang['hardcoded']['invoiceExpiredNotice'], $status_var, $result['id_order'], $result['price']);
// sendmessage($result['id_user'], $textexpire, null, 'html');
deletemessage($result['id_user'], $result['message_id']);
update("Payment_report","payment_Status","expire","id_order",$result['id_order']);
}
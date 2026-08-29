<?php
ini_set('error_log', 'error_log');
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../jdf.php';
require_once __DIR__ . '/../botapi.php';
require_once __DIR__ . '/../Marzban.php';
require_once __DIR__ . '/../function.php';
require_once __DIR__ . '/../panels.php';
require_once __DIR__ . '/../keyboard.php';
require __DIR__ . '/../vendor/autoload.php';
use Endroid\QrCode\Builder\Builder;
use Endroid\QrCode\Encoding\Encoding;
use Endroid\QrCode\ErrorCorrectionLevel;
use Endroid\QrCode\Label\Font\OpenSans;
use Endroid\QrCode\Label\LabelAlignment;
use Endroid\QrCode\RoundBlockSizeMode;
use Endroid\QrCode\Writer\PngWriter;

$ManagePanel = new ManagePanel();
$data = json_decode(file_get_contents("php://input"), true);
$Payment_report = select("Payment_report", "*", "id_order", $data['PaymentID'], "select");
if (!$Payment_report)
    return;
$apitronseller = select("PaySetting", "*", "NamePay", "apiternado", "select")['ValuePay'];
if ($Payment_report['payment_Status'] == "expire")
    return;
$setting = select("setting", "*", null, null, "select");
$price = $Payment_report['price'];
if ($Payment_report['payment_Status'] != "paid") {
    $headers = [
        'Content-Type' => "application/json",
        'x-api-key' => $apitronseller
    ];
    $req = new CurlRequest("https://bot.tronado.cloud/Order/GetStatus");
    $req->setHeaders($headers);
    $order_id = explode('TrndOrderID_', $data['Hash'])[1];
    $response = $req->post(array('id' => $order_id));
    $response = is_string($response['body']) ? json_decode($response['body'], true) : false;
    if ($response && $response['IsPaid'] && $data['IsPaid'] && $data['TronAmount'] == $response['TronAmount']) {
        echo json_encode(array("status" => true));
        $textbotlang = languagechange();
        DirectPayment($data['PaymentID'], "../images.jpg");
        $pricecashback = select("PaySetting", "ValuePay", "NamePay", "chashbackiranpay2", "select")['ValuePay'];
        $Balance_id = select("user", "*", "id", $Payment_report['id_user'], "select");
        if ($pricecashback != "0") {
            $result = ($Payment_report['price'] * $pricecashback) / 100;
            $Balance_confrim = intval($Balance_id['Balance']) + $result;
            update("user", "Balance", $Balance_confrim, "id", $Balance_id['id']);
            $pricecashback = number_format($pricecashback);
            $text_report = sprintf($textbotlang['paymentGateway']['giftReport'], $result);
            sendmessage($Balance_id['id'], $text_report, null, 'HTML');
        }
        $paymentreports = select("topicid", "idreport", "report", "paymentreport", "select")['idreport'];
        $balancelow = "";
        if ($data['TronAmount'] < $data['ActualTronAmount']) {
            $balancelow = $textbotlang['paymentGateway']['lowAmount'];
        }
        $text_reportpayment = sprintf($textbotlang['paymentGateway']['reportTronado'], $balancelow, $Balance_id['username'], $Balance_id['id'], $price, $data['Hash'], $data['TronAmount']);
        $Status_change = "paid";
        $statement = $pdo->prepare("UPDATE Payment_report SET payment_Status = :payment_Status WHERE id_order = :id_order");
        $statement->bindValue(':payment_Status', $Status_change);
        $statement->bindValue(':id_order', $Payment_report['id_order']);
        $statement->execute();
        $database = json_encode($data);
        $statement = $pdo->prepare("UPDATE Payment_report SET dec_not_confirmed = :dec_not_confirmed WHERE id_order = :id_order");
        $statement->bindValue(':dec_not_confirmed', $database);
        $statement->bindValue(':id_order', $Payment_report['id_order']);
        $statement->execute();
        if (strlen($setting['Channel_Report']) > 0) {
            telegram('sendmessage', [
                'chat_id' => $setting['Channel_Report'],
                'message_thread_id' => $paymentreports,
                'text' => $text_reportpayment,
                'parse_mode' => "HTML"
            ]);
        }
    }
}
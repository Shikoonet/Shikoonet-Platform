<?php

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../function.php';
require_once __DIR__ . '/../botapi.php';
header('Content-Type: application/json');
date_default_timezone_set('Asia/Tehran');
ini_set('default_charset', 'UTF-8');
ini_set('error_log', 'error_log');


$textbotlang = languagechange();
$keyboardmain = json_decode(select("setting", "keyboardmain", null, null, "select")['keyboardmain'], true);

$list_keyboard = array(
    'text_sell',
    'text_extend',
    'text_usertest',
    'text_wheel_luck',
    'text_Purchased_services',
    'accountwallet',
    'text_affiliates',
    'text_Tariff_list',
    'text_support',
    'text_help',
);
$textbotlang['textbot'] = [
    'text_sell' => $textbotlang['textbot']['sell'],
    'text_extend' => $textbotlang['textbot']['extend'],
    'text_usertest' => $textbotlang['textbot']['userTest'],
    'text_wheel_luck' => $textbotlang['textbot']['wheelLuck'],
    'text_Purchased_services' => $textbotlang['textbot']['purchasedServices'],
    'accountwallet' => $textbotlang['textbot']['accountWallet'],
    'text_affiliates' => $textbotlang['textbot']['affiliates'],
    'text_Tariff_list' => $textbotlang['textbot']['tariffList'],
    'text_support' => $textbotlang['textbot']['support'],
    'text_help' => $textbotlang['textbot']['help'],
];
foreach ($keyboardmain['keyboard'] as $keyboard) {
    foreach ($keyboard as $arrkey) {
        if (in_array($arrkey['text'], $list_keyboard)) {
            $index_number = array_search($arrkey['text'], $list_keyboard);
            unset($list_keyboard[$index_number]);
        }
    }
}
$list_keyboard = array_values($list_keyboard);
$keyboard = [];
foreach ($list_keyboard as $key) {
    $keyboard[] = [['text' => $key]];
}

$list_data = [
    'keylist' => $keyboard,
    'userlist' => $keyboardmain['keyboard'],
    'text' => $textbotlang['textbot']
];
echo json_encode($list_data);
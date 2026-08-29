<?php
ini_set('error_log', 'error_log');
date_default_timezone_set('Asia/Tehran');
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../botapi.php';
require_once __DIR__ . '/../function.php';
$textbotlang = languagechange();

$setting = select("setting", "*");
$otherreport = select("topicid","idreport","report","otherreport","select")['idreport'];
// buy service 
$stmt = $pdo->prepare("SELECT * FROM user WHERE expire IS NOT NULL");
$stmt->execute();
while ($user = $stmt->fetch(PDO::FETCH_ASSOC)) {
    $time_expire = $user['expire'] - time();
    if($time_expire < 0){
    $textexpire = $textbotlang['hardcoded']['agentExpiredNotice'];
    sendmessage($user['id'],$textexpire, null, 'HTML');
    update("user","agent","f","id",$user['id']);
    update("user","expire",null,"id",$user['id']);
    $textreport = sprintf($textbotlang['hardcoded']['agentExpiredGroupChangedLog'], $user['id'], $user['username']);
    if (strlen($setting['Channel_Report']) > 0) {
        telegram('sendmessage',[
            'chat_id' => $setting['Channel_Report'],
            'message_thread_id' => $otherreport,
            'text' => $textreport,
            'parse_mode' => "HTML"
        ]);
    }
    }

}
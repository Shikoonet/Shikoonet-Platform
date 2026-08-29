<?php
require_once '../config.php';
require_once '../function.php';
$textbotlang = languagechange();
require_once '../botapi.php';

$reportbackup = select("topicid", "idreport", "report", "backupfile", "select")['idreport'];
$destination = getcwd();
$setting = select("setting", "*");
$sourcefir = dirname($destination);
$botlist = select("botsaz", "*", null, null, "fetchAll");
if ($botlist) {
    foreach ($botlist as $bot) {
        $folderName = $bot['id_user'] . $bot['username'];
        shell_exec("zip -r $destination/file.zip $sourcefir/vpnbot/$folderName/data $sourcefir/vpnbot/$folderName/product.json $sourcefir/vpnbot/$folderName/product_name.json");
        telegram('sendDocument', [
            'chat_id' => $setting['Channel_Report'],
            'message_thread_id' => $reportbackup,
            'document' => new CURLFile('file.zip'),
            'caption' => "@{$bot['username']} | {$bot['id_user']}",
        ]);
        unlink('file.zip');
    }
}

$backup_file_name = 'backup_' . date("Y-m-d") . '.sql';
$zip_file_name = 'backup_' . date("Y-m-d") . '.zip';
$dbhost = empty($dbhost) ? "localhost" : $dbhost;
$command = "mysqldump -h $dbhost -u $usernamedb -p'$passworddb' --no-tablespaces --ssl-mode=DISABLED $dbname > $backup_file_name";

$output = [];
$return_var = 0;
exec($command, $output, $return_var);
if ($return_var !== 0) {
    telegram('sendmessage', [
        'chat_id' => $setting['Channel_Report'],
        'message_thread_id' => $reportbackup,
        'text' => $textbotlang['keyboard']['backupError'],
    ]);
} else {
    telegram('sendDocument', [
        'chat_id' => $setting['Channel_Report'],
        'message_thread_id' => $reportbackup,
        'document' => new CURLFile($backup_file_name),
        'caption' => $textbotlang['hardcoded']['backupDatabaseCaption'],
    ]);
    unlink($backup_file_name);
}
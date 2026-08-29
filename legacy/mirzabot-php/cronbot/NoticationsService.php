<?php
ini_set('error_log', 'error_log');
date_default_timezone_set('Asia/Tehran');

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../botapi.php';
require_once __DIR__ . '/../panels.php';
require_once __DIR__ . '/../function.php';
class ServiceMonitor
{
    private $Panel;
    private $pdo;
    private $setting;
    private $reportCron;
    private $text_Purchased_services;
    private $status_cron;
    const SECONDS_PER_DAY = 86400;
    private $textBotLang;

    public function __construct()
    {
        global $pdo;
        $this->pdo = $pdo;
        $this->Panel = new ManagePanel();
        $this->reportCron = select("topicid", "idreport", "report", "reportcron", "select")['idreport'];
        $this->setting = select("setting", "*");
        $this->status_cron = json_decode($this->setting['cron_status'], true);
        $this->textBotLang = languagechange(dirname(__DIR__));
        $this->text_Purchased_services = $this->textBotLang['textbot']['purchasedServices'] ?? '';
    }

    public function RunNotifactions()
    {
        $invoices = $this->getActiveInvoices();
        if ($invoices == false)
            return;
        foreach ($invoices as $invoice) {
            if ($invoice['time_cron'] != null) {
                $time_cron = time() - $invoice['time_cron'];
                if ($time_cron < 1600)
                    continue;
            }
            update("invoice", "time_cron", time(), "id_invoice", $invoice['id_invoice']);
            $check_send = json_decode($invoice['notifctions'], true);
            $data = $this->processInvoice($invoice);
            if (!is_array($data))
                continue;
            $result = false;
            if (!$check_send['volume']) {
                if ($this->status_cron['volume'])
                    $result = $this->checkVolumeThreshold($data['invoice'], $data['user'], $data['userData'], $invoice['username']);
            }
            if ($result)
                $data['invoice'] = select("invoice", "*", "id_invoice", $invoice['id_invoice']);
            if (!$check_send['time']) {
                if ($this->status_cron['day'])
                    $this->checkTimeExpiration($data['invoice'], $data['user'], $data['userData'], $invoice['username']);
            }
            if ($this->status_cron['remove'])
                $this->shouldRemoveService($data['invoice'], $data['user'], $data['userData'], $invoice['username']);
            if ($this->status_cron['remove_volume'])
                $this->shouldRemoveServiceـvolume($data['invoice'], $data['user'], $data['userData'], $invoice['username']);
            if ($data['panel']['inboundstatus'] == "oninbounddisable" && $data['panel']['type'] == "marzban")
                $this->active_inbound_expire($data['invoice'], $data['userData'], $data['panel']);
        }
    }


    private function getActiveInvoices()
    {
        $time_hours = time() - 3600;
        $QUERY = "SELECT * FROM invoice WHERE (Status = 'active' OR Status = 'end_of_time' OR Status = 'end_of_volume' OR Status = 'sendedwarn' OR Status = 'send_on_hold') AND name_product != '{$this->textBotLang['Admin']['adminphp']['db_test_service_name']}' AND (time_cron <= '$time_hours' OR time_cron IS NULL) ORDER BY time_cron  LIMIT 30";
        $stmt = $this->pdo->prepare($QUERY);
        $stmt->execute();
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    private function processInvoice($invoice)
    {
        $username = $invoice['username'];

        // Get panel information
        $panelInfo = select("marzban_panel", "*", "name_panel", $invoice['Service_location'], "select");
        if (!$panelInfo)
            return false;

        if ($panelInfo['status'] == "disabled")
            return false;
        // Get user information
        $user = select("user", "*", "id", $invoice['id_user'], "select");
        if ($user == false)
            return false;

        // Get username data from panel
        $userData = $this->Panel->DataUser($invoice['Service_location'], $username);
        if (!$userData || $userData['status'] == "Unsuccessful")
            return;
        return [
            'invoice' => $invoice,
            'panel' => $panelInfo,
            'user' => $user,
            'userData' => $userData
        ];
    }

    private function checkVolumeThreshold($invoice, $user, $userData, $username)
    {
        $remainingVolume = $userData['data_limit'] - $userData['used_traffic'];
        $volumeWarningThreshold = $this->setting['volumewarn'] * pow(1024, 3);
        $isVolumeWarning = $remainingVolume <= $volumeWarningThreshold && $remainingVolume > 0 && in_array($userData['status'], ['active', 'Unknown']);

        if ($isVolumeWarning) {
            $formattedVolume = formatBytes($remainingVolume);
            $message = $this->textBotLang['hardcoded']['notifGreeting'] .
                sprintf($this->textBotLang['hardcoded']['notifVolumeRemaining'], $username, $formattedVolume) .
                sprintf($this->textBotLang['hardcoded']['notifVolumeActionHint'], $this->text_Purchased_services);
            $reportMessage = $this->textBotLang['hardcoded']['notifVolumeCronTitle'] .
                sprintf($this->textBotLang['hardcoded']['notifServiceUsername'], $username) .
                sprintf($this->textBotLang['hardcoded']['notifServiceStatus'], $userData['status']) .
                sprintf($this->textBotLang['hardcoded']['notifRemainingVolume'], $formattedVolume);
            $this->send_notifactions($invoice, $user, $message, true, $invoice['bottype']);
            $this->sendReportNotification($reportMessage);
            $this->updateInvoiceStatus("volume", $invoice);
            return true;
        }
    }
    private function shouldRemoveService($invoice, $user, $userData, $username)
    {
        if (!in_array($userData['status'], ['limited', 'expired']))
            return false;
        $timeService = $userData['expire'] - time();
        $daysRemaining = intval($timeService / 86400);
        $removalThreshold = intval("-" . $this->setting['removedayc']);
        $result = $daysRemaining <= $removalThreshold;
        $statusText = $statusMap = [
            'active' => $this->textBotLang['users']['stateus']['active'],
            'limited' => $this->textBotLang['users']['stateus']['limited'],
            'disabled' => $this->textBotLang['users']['stateus']['disabled'],
            'expired' => $this->textBotLang['users']['stateus']['expired'],
            'on_hold' => $this->textBotLang['users']['stateus']['on_hold'],
            'Unknown' => $this->textBotLang['users']['stateus']['Unknown']
        ][$userData['status']];
        $remainingVolume = formatBytes($userData['data_limit'] - $userData['used_traffic']);
        if ($result) {
            update("invoice", "status", "removeTime", "username", $username);
            $this->Panel->RemoveUser($invoice['Service_location'], $username);
            $message = sprintf($this->textBotLang['hardcoded']['notifServiceDeleted'], $invoice['username']);
            $reportMessage = sprintf($this->textBotLang['hardcoded']['notifDeleteCronInfo'], $invoice['username'], $statusText, $daysRemaining, $remainingVolume);
            $this->send_notifactions($invoice, $user, $message, false, $invoice['bottype']);
            $this->sendReportNotification($reportMessage);
        }
    }
    private function shouldRemoveServiceـvolume($invoice, $user, $userData, $username)
    {
        if (!in_array($userData['status'], ['limited', 'expired']))
            return false;
        $panel = select("marzban_panel", "*", "name_panel", $invoice['Service_location'], "select");
        if ($panel['type'] != "marzban")
            return;
        if ($userData['data_limit_reset'] != "no_reset")
            return;
        if ($userData['status'] == "Unsuccessful")
            return;
        if (in_array($userData['status'], ['Unknown', 'active', 'on_hold', 'disabled', 'expired']))
            return;
        if (empty($userData['online_at']) or $userData['online_at'] == null) {
            $timelastconect = 0;
        } else {
            $time = strtotime($userData['online_at']);
            $timelastconect = (time() - $time) / 86400;
        }
        if ($timelastconect == 0)
            return;
        $timeService = $userData['expire'] - time();
        $daysRemaining = intval($timeService / 86400);
        $removalThreshold = intval($this->setting['cronvolumere']);
        $result = $timelastconect >= $removalThreshold;
        $statusText = [
            'active' => $this->textBotLang['users']['stateus']['active'],
            'limited' => $this->textBotLang['users']['stateus']['limited'],
            'disabled' => $this->textBotLang['users']['stateus']['disabled'],
            'expired' => $this->textBotLang['users']['stateus']['expired'],
            'on_hold' => $this->textBotLang['users']['stateus']['on_hold'],
            'Unknown' => $this->textBotLang['users']['stateus']['Unknown']
        ][$userData['status']];
        $remainingVolume = formatBytes($userData['data_limit'] - $userData['used_traffic']);
        if ($result) {
            update("invoice", "status", "removevolume", "username", $username);
            $this->Panel->RemoveUser($invoice['Service_location'], $username);
            $message = sprintf($this->textBotLang['hardcoded']['notifServiceDeleted2'], $username);
            $reportMessage = sprintf($this->textBotLang['hardcoded']['notifVolumeDeleteCronInfo'], $username, $statusText, $daysRemaining, $remainingVolume, $userData['online_at']);
            $this->send_notifactions($invoice, $user, $message, false, $invoice['bottype']);
            $this->sendReportNotification($reportMessage);
        }
    }
    private function active_inbound_expire($invoice, $userData, $panel_info)
    {
        if ($invoice['uuid'] != null || $userData['data_limit_reset'] != "no_reset")
            return;
        $inbound = explode("*", $panel_info['inbound_deactive']);
        update("invoice", "uuid", json_encode($userData['uuid']), "id_invoice", $invoice['id_invoice']);
        $proxies = [];
        $proxies[$inbound[0]] = new stdClass();
        ;
        $inbounds[$inbound[0]][] = $inbound[1];
        $configs = array(
            "proxies" => $proxies,
            "inbounds" => $inbounds
        );
        $this->Panel->Modifyuser($invoice['username'], $panel_info['code_panel'], $configs);
    }
    private function checkTimeExpiration($invoice, $user, $userData, $username)
    {
        $validStatuses = ['expired', 'on_hold', 'limited'];
        if (in_array($userData['status'], $validStatuses))
            return;
        $timeRemaining = $userData['expire'] - time();
        $daysRemaining = intval($timeRemaining / self::SECONDS_PER_DAY);
        $warningThreshold = intval($this->setting['daywarn']) * self::SECONDS_PER_DAY;

        $isTimeWarning = $timeRemaining <= $warningThreshold && $timeRemaining > 0;

        if ($isTimeWarning) {
            $message = $this->textBotLang['hardcoded']['notifGreeting2'] .
                sprintf($this->textBotLang['hardcoded']['notifTimeRemaining'], $username, $daysRemaining) .
                sprintf($this->textBotLang['hardcoded']['notifTimeActionHint'], $this->text_Purchased_services) .
                $this->textBotLang['hardcoded']['notifThanks'];
            $reportMessage = $this->textBotLang['hardcoded']['notifTimeCronTitle'] .
                sprintf($this->textBotLang['hardcoded']['notifServiceUsername2'], $invoice['username']) .
                sprintf($this->textBotLang['hardcoded']['notifServiceStatus2'], $userData['status']) .
                sprintf($this->textBotLang['hardcoded']['notifRemainingDays'], $daysRemaining);
            $this->send_notifactions($invoice, $user, $message, true, $invoice['bottype']);
            $this->sendReportNotification($reportMessage);
            $this->updateInvoiceStatus("time", $invoice);
            return true;
        }
    }

    private function send_notifactions($invoice, $status_cron_user, $message, $keyboard_active, $bot_token)
    {
        if (intval($status_cron_user) == 0)
            return;
        $keyboard = $this->createExtendServiceKeyboard($invoice['id_invoice']);
        $keyboard = $keyboard_active ? $keyboard : null;
        sendmessage($invoice['id_user'], $message, $keyboard, 'HTML', $bot_token);
    }

    public function createExtendServiceKeyboard($invoiceId)
    {
        return json_encode([
            'inline_keyboard' => [
                [
                    ['text' => $this->textBotLang['keyboard']['renewService'], 'callback_data' => 'extend_' . $invoiceId],
                ],
            ]
        ]);
    }

    private function sendReportNotification($reportMessage)
    {
        if (empty($this->setting['Channel_Report']))
            return;


        telegram('sendmessage', [
            'chat_id' => $this->setting['Channel_Report'],
            'message_thread_id' => $this->reportCron,
            'text' => $reportMessage,
            'parse_mode' => "HTML"
        ]);
    }

    private function updateInvoiceStatus($type, $invoice)
    {
        $data = json_decode($invoice['notifctions'], true);
        $data[$type] = true;
        $data = json_encode($data);
        update("invoice", "notifctions", $data, "id_invoice", $invoice['id_invoice']);
    }
}

// Execute the volume monitoring
$volumeMonitor = new ServiceMonitor();
$volumeMonitor->RunNotifactions();
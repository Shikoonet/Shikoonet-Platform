    if ($datain == "cart_to_offline") {
        $PaySetting = select("PaySetting", "ValuePay", "NamePay", "statuscardautoconfirm", "select")['ValuePay'];
        $checkpay = $pdo->prepare("SELECT * FROM Payment_report WHERE id = :user_id AND payment_Status = 'Unpaid'");
        $checkpay->bindValue(':user_id', $from_id, PDO::PARAM_STR);
        $checkpay->execute();
        if (($checkpay)->rowCount() != 0) {
            sendmessage($from_id, $textbotlang['Admin']['SettingPayment']['isSetPay'], null, 'HTML');
            return;
        }
        $mainbalance = select("PaySetting", "ValuePay", "NamePay", "minbalancecart", "select")['ValuePay'];
        $maxbalance = select("PaySetting", "ValuePay", "NamePay", "maxbalancecart", "select")['ValuePay'];
        if ($user['Processing_value'] < $mainbalance || $user['Processing_value'] > $maxbalance) {
            $mainbalance = number_format($mainbalance);
            $maxbalance = number_format($maxbalance);
            sendmessage($from_id, strtr($textbotlang['extracted']['index_php']['depositAmountRange'], ['{mainbalance}' => $mainbalance, '{maxbalance}' => $maxbalance]), null, 'HTML');
            return;
        }
        $randomString = bin2hex(random_bytes(5));
        if (function_exists('cardAssignmentEnabled') && cardAssignmentEnabled()) {
            $assignment = getOrAssignCard((string) $from_id, $randomString);
            if (!$assignment['ok']) {
                if (($assignment['error'] ?? '') === 'all_cards_leased_or_unavailable') {
                    sendmessage($from_id, cardAssignmentAllCardsBusyMessage(), null, 'HTML');
                } else {
                    sendmessage($from_id, $textbotlang['extracted']['index_php']['bankCardRetrieveError'], null, 'HTML');
                }
                return;
            }
            $card_number = $assignment['cardnumber'];
            $PaySettingname = $assignment['namecard'];
            cardAssignmentPersistOrderCardState((string) $from_id, $randomString, $card_number, $PaySettingname);
        } else {
            $card_info = pickNextCardForPayment($pdo);
            if (!$card_info || empty($card_info['cardnumber']) || empty($card_info['namecard'])) {
                sendmessage($from_id, $textbotlang['extracted']['index_php']['noActiveBankCard'], null, 'HTML');
                return;
            }
            $card_number = $card_info['cardnumber'];
            $PaySettingname = $card_info['namecard'];
        }
        $price_copy = $user['Processing_value'];
        if ($PaySetting == "onautoconfirm") {
            $random_number = rand(0, 2000);
            $user['Processing_value'] = intval($user['Processing_value']) + $random_number;
            if (in_array($user['Processing_value'], $pricepayment)) {
                $random_number = rand(0, 2000);
                $user['Processing_value'] = intval($user['Processing_value']) + $random_number;
            }
            $valueshow = "{$user['Processing_value']}0";
            $replacements = [
                '{price}' => $valueshow,
                '{card_number}' => $card_number,
                '{name_card}' => $PaySettingname,
            ];
            $price_copy = $valueshow;
            $textcart = strtr($textbotlang['textbot']['cartAuto'], $replacements);
            update("user", "Processing_value", $user['Processing_value'], "id", $from_id);
        } else {
            $valueprice = number_format($user['Processing_value']);
            $replacements = [
                '{price}' => $valueprice,
                '{card_number}' => $card_number,
                '{name_card}' => $PaySettingname,
            ];
            $price_copy = intval($user['Processing_value'] . "0");
            $textcart = strtr($textbotlang['textbot']['cart'], $replacements);
        }
        $invoice = "{$user['Processing_value_tow']}|{$user['Processing_value_one']}";
        $dateacc = date('Y/m/d H:i:s');
        if (function_exists('cardAssignmentEnabled') && cardAssignmentEnabled()) {
            $stmt = $pdo->prepare(
                "INSERT INTO Payment_report (id_user,id_order,time,price,payment_Status,Payment_Method,id_invoice,assigned_card_number,assigned_card_name) VALUES (?,?,?,?,?,?,?,?,?)"
            );
            $payment_Status = "Unpaid";
            $Payment_Method = "cart to cart";
            $stmt->execute([
                $from_id, $randomString, $dateacc, $user['Processing_value'], $payment_Status, $Payment_Method, $invoice,
                $card_number, $PaySettingname,
            ]);
        } else {
            $stmt = $pdo->prepare("INSERT INTO Payment_report (id_user,id_order,time,price,payment_Status,Payment_Method,id_invoice) VALUES (?,?,?,?,?,?,?)");
            $payment_Status = "Unpaid";
            $Payment_Method = "cart to cart";
            $stmt->execute([$from_id, $randomString, $dateacc, $user['Processing_value'], $payment_Status, $Payment_Method, $invoice]);
        }
        savePaymentCardForOrder($from_id, $randomString, $textcart);
        deletemessage($from_id, $message_id);
        if ($setting['statuscopycart'] == "1") {
            $sendresidcart = json_encode([
                'inline_keyboard' => [
                    [
                        ['text' => $textbotlang['keyboard']['copyCardNumber'], 'copy_text' => ["text" => $card_number]],
                        ['text' => $textbotlang['keyboard']['copyAmount'], 'copy_text' => ["text" => $price_copy]]
                    ],
                    [
                        ['text' => $textbotlang['keyboard']['paidSendReceipt'], 'callback_data' => "sendresidcart-" . $randomString]
                    ]
                ]
            ]);
        } else {
            $sendresidcart = json_encode([
                'inline_keyboard' => [
                    [
                        ['text' => $textbotlang['keyboard']['paidSendReceipt'], 'callback_data' => "sendresidcart-" . $randomString]
                    ]
                ]
            ]);
        }
        $gethelp = select("PaySetting", "ValuePay", "NamePay", "helpcart", "select")['ValuePay'];
        if ($gethelp != 2) {
            $data = json_decode($gethelp, true);
            if ($data['type'] == "text") {
                sendmessage($from_id, $data['text'], null, 'HTML');
            } elseif ($data['type'] == "photo") {
                sendphoto($from_id, $data['photoid'], $data['text']);
            } elseif ($data['type'] == "video") {
                sendvideo($from_id, $data['videoid'], $data['text']);
            }
        }
        $message_id = telegram('sendmessage', [
            'chat_id' => $from_id,
            'text' => $textcart,
            'reply_markup' => $sendresidcart,
            'parse_mode' => "html",
        ]);
        updatePaymentMessageId($message_id, $randomString);

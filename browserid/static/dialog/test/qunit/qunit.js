steal("/dialog/resources/browserid.js",
      "/dialog/resources/browser-support.js",
      "/dialog/resources/storage.js",
      "/dialog/resources/tooltip.js",
      "/dialog/resources/validation.js",
      "/dialog/resources/underscore-min.js")
  .plugins(
    "jquery", 
    "jquery/controller",
    "jquery/controller/subscribe",
    "jquery/controller/view",
    "jquery/view/ejs",
    "funcunit/qunit")
	.views('testBodyTemplate.ejs')
	.views('wait.ejs',
         'pickemail.ejs')
  .then("browserid_unit_test")
  .then("include_unit_test")
  .then("relay/relay_unit_test")
  .then("pages/add_email_address_test")
  .then("resources/channel_unit_test")
  .then("resources/browser-support_unit_test")
  .then("resources/validation_unit_test")
  .then("resources/storage_unit_test")
  .then("resources/network_unit_test")
  .then("resources/user_unit_test")
  .then("controllers/page_controller_unit_test")
  .then("controllers/pickemail_controller_unit_test")


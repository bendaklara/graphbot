/*
 * Copyright 2016-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* jshint node: true, devel: true */
'use strict';

const 
  bodyParser = require('body-parser'),
  config = require('config'),
  crypto = require('crypto'),
  express = require('express'),
  https = require('https'),  
  request = require('request');
  
var graph = require('fbgraph');
var url = require('url');

var options = {
    timeout:  3000
  , pool:     { maxSockets:  Infinity }
  , headers:  { connection:  "keep-alive" }
};

var match='/';

var app = express();
app.set('port', process.env.PORT || 5555);
app.set('view engine', 'ejs');
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.use(express.static('public'));

/*
 * Be sure to setup your config values before running this code. You can 
 * set them using environment variables or modifying the config file in /config.
 *
 */

// App Secret can be retrieved from the App Dashboard
const APP_SECRET = (process.env.MESSENGER_APP_SECRET) ? 
  process.env.MESSENGER_APP_SECRET :
  config.get('appSecret');

// Arbitrary value used to validate a webhook
const VALIDATION_TOKEN = (process.env.MESSENGER_VALIDATION_TOKEN) ?
  (process.env.MESSENGER_VALIDATION_TOKEN) :
  config.get('validationToken');

// Generate a page access token for your page from the App Dashboard
const PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN) ?
  (process.env.MESSENGER_PAGE_ACCESS_TOKEN) :
  config.get('pageAccessToken');
// Set background access token
const WORKER_PAGE_ACCESS_TOKEN = (process.env.MESSENGER_WORKER_PAGE_ACCESS_TOKEN) ?
  (process.env.MESSENGER_WORKER_PAGE_ACCESS_TOKEN) :
  config.get('workerPageAccessToken');
  console.log(WORKER_PAGE_ACCESS_TOKEN);
// URL where the app is running (include protocol). Used to point to scripts and 
// assets located at this address. 
const SERVER_URL = (process.env.SERVER_URL) ?
  (process.env.SERVER_URL) :
  config.get('serverURL');

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN && SERVER_URL)) {
  console.error("Missing config values");
  process.exit(1);
}

/*
 * Use your own validation token. Check that the token used in the Webhook 
 * setup is the same token used here.
 *
 */
 
app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === VALIDATION_TOKEN) {
    console.log("Validating webhook");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);          
  }  
});



/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page. 
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 *
 */
app.post('/webhook', function (req, res) {
  var data = req.body;

  // Make sure this is a page subscription
  if (data.object == 'page') {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function(pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      // Iterate over each messaging event
      pageEntry.messaging.forEach(function(messagingEvent) {
        if (messagingEvent.optin) {
          receivedAuthentication(messagingEvent);
        } else if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else if (messagingEvent.delivery) {
          receivedDeliveryConfirmation(messagingEvent);
        } else if (messagingEvent.postback) {
          receivedPostback(messagingEvent);
        } else if (messagingEvent.read) {
          receivedMessageRead(messagingEvent);
        } else if (messagingEvent.account_linking) {
          receivedAccountLink(messagingEvent);
        } else {
          console.log("Webhook received unknown messagingEvent: ", messagingEvent);
        }
      });
    });

    // Assume all went well.
    //
    // You must send back a 200, within 20 seconds, to let us know you've 
    // successfully received the callback. Otherwise, the request will time out.
    res.sendStatus(200);
  }
});

/*
 * This path is used for account linking. The account linking call-to-action
 * (sendAccountLinking) is pointed to this URL. 
 * 
 */
app.get('/authorize', function(req, res) {
  var accountLinkingToken = req.query.account_linking_token;
  var redirectURI = req.query.redirect_uri;

  // Authorization Code should be generated per user by the developer. This will 
  // be passed to the Account Linking callback.
  var authCode = "1234567890";

  // Redirect users to this URI on successful login
  var redirectURISuccess = redirectURI + "&authorization_code=" + authCode;

  res.render('authorize', {
    accountLinkingToken: accountLinkingToken,
    redirectURI: redirectURI,
    redirectURISuccess: redirectURISuccess
  });
});

/*
 * Verify that the callback came from Facebook. Using the App Secret from 
 * the App Dashboard, we can verify the signature that is sent with each 
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    // For testing, let's log an error. In production, you should throw an 
    // error.
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', APP_SECRET)
                        .update(buf)
                        .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to 
 * Messenger" plugin, it is the 'data-ref' field. Read more at 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
 *
 */
function receivedAuthentication(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfAuth = event.timestamp;

  // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
  // The developer can set this to an arbitrary value to associate the 
  // authentication callback with the 'Send to Messenger' click event. This is
  // a way to do account linking when the user clicks the 'Send to Messenger' 
  // plugin.
  var passThroughParam = event.optin.ref;

  console.log("Received authentication for user %d and page %d with pass " +
    "through param '%s' at %d", senderID, recipientID, passThroughParam, 
    timeOfAuth);

  // When an authentication is received, we'll send a message back to the sender
  // to let them know it was successful.
  sendTextMessage(senderID, "Authentication successful");
}

/*
 * Message Event
 *
 * This event is called when a message is sent to your page. The 'message' 
 * object format can vary depending on the kind of message that was received.
 * Read more at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
 *
 * For this example, we're going to echo any text that we get. If we get some 
 * special keywords ('button', 'generic', 'receipt'), then we'll send back
 * examples of those bubbles to illustrate the special message bubbles we've 
 * created. If we receive a message with an attachment (image, video, audio), 
 * then we'll simply confirm that we've received the attachment.
 * 
 */
function receivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  console.log("Received message for user %d and page %d at %d with message:", 
    senderID, recipientID, timeOfMessage);
  console.log(JSON.stringify(message));

  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata;

  // You may get a text or attachment but not both
  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;

  if (isEcho) {
    // Just logging message echoes to console
    console.log("Received echo for message %s and app %d with metadata %s", 
      messageId, appId, metadata);
    return;
  } else if (quickReply) {
    var quickReplyPayload = quickReply.payload;
    console.log("Quick reply for message %s with payload %s",
      messageId, quickReplyPayload);

    sendTextMessage(senderID, "Quick reply tapped");
    return;
  }

  if (messageText) {

    // If we receive a text message, check to see if it matches any special
    // keywords and send back the corresponding example. Otherwise, just echo
    // the text we received.
    switch (messageText.replace(/[^\w\s]/gi, '').trim().toLowerCase()) {
      case 'help':
      case 'Help!':
	  case 'Help':	  
        sendHelpMessage(senderID);
        break;
      case 'newtoken':
        sendNewtokenMessage(senderID);
        break;
		
      case 'oldtoken':
        sendOldtokenMessage(senderID);
        break;		
		
      case 'privacy':
      case 'policy':
      case 'privacy policy':
        sendPPMessage(senderID);
        break;

      case 'TOKEN':
        sendTextMessage(senderID, messageText);
        break;


      default:
        sendGraph(senderID, messageText);
    }
  } else if (messageAttachments) {
    sendTextMessage(senderID, "What is all the fluff with attachments? Blurt out a page name instead.");
  }
}


/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about 
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 *
 */
function receivedDeliveryConfirmation(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var delivery = event.delivery;
  var messageIDs = delivery.mids;
  var watermark = delivery.watermark;
  var sequenceNumber = delivery.seq;

  if (messageIDs) {
    messageIDs.forEach(function(messageID) {
      console.log("Received delivery confirmation for message ID: %s", 
        messageID);
    });
  }

  console.log("All message before %d were delivered.", watermark);
}


/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message. 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 * 
 */
function receivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp;
  var payloadresponse='';
  // The 'payload' param is a developer-defined field which is set in a postback 
  // button for Structured Messages. 
  var payload = event.postback.payload;

  console.log("Received postback for user %d and page %d with payload '%s' " + 
    "at %d", senderID, recipientID, payload, timeOfPostback);
  if (payload=='GETSTARTED_PAYLOAD'){
	  payloadresponse='Hello. I am here to help you explore if pages of a feather flock together on Facebook. Blurt out a page name, or type help for some fluffy instructions.'
  }
  if (payload=='HOWTO_PAYLOAD'){
	  payloadresponse='Give me the name of a FB page! You can write https://www.facebook.com/facebook, facebook, https://facebook.com/Birds-of-a-Feather-2179257909023050 or 2179257909023050';  
 }
  // When a postback is called, we'll send a message back to the sender to 
  // let them know it was successful
  
  sendTextMessage(senderID, payloadresponse);
}

/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 * 
 */
function receivedMessageRead(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  // All messages before watermark (a timestamp) or sequence have been seen.
  var watermark = event.read.watermark;
  var sequenceNumber = event.read.seq;

  console.log("Received message read event for watermark %d and sequence " +
    "number %d", watermark, sequenceNumber);
}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 * 
 */
function receivedAccountLink(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  var status = event.account_linking.status;
  var authCode = event.account_linking.authorization_code;

  console.log("Received account link event with for user %d with status %s " +
    "and auth code %s ", senderID, status, authCode);
}

/*
 * Send an image using the Send API.
 *
 */
function sendImageMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: SERVER_URL + "/assets/rift.png"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a Gif using the Send API.
 *
 */
function sendGifMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: SERVER_URL + "/assets/instagram_logo.gif"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send audio using the Send API.
 *
 */
function sendAudioMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "audio",
        payload: {
          url: SERVER_URL + "/assets/sample.mp3"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a video using the Send API.
 *
 */
function sendVideoMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "video",
        payload: {
          url: SERVER_URL + "/assets/allofus480.mov"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a file using the Send API.
 *
 */
function sendFileMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "file",
        payload: {
          url: SERVER_URL + "/assets/test.txt"
        }
      }
    }
  };

  callSendAPI(messageData);
}

function sendHelpMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: `
		Give me the name of a FB page! You can write https://www.facebook.com/facebook, facebook, https://facebook.com/Birds-of-a-Feather-2179257909023050 or 2179257909023050
	  `
    }
  }

  callSendAPI(messageData);
}

/*
 * Privacy policy.
 *
 */
function sendPPMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: `
My privacy policy is available here: https://datadatbot.tk/privacypolicy/privacypolicybirdsbot.html     
	  `
    }
  }

  callSendAPI(messageData);
}





/*
 * Send a text message using the Send API.
 *
 */
function sendTextMessage(recipientId, messageText) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText,
      metadata: "DEVELOPER_DEFINED_METADATA"
    }
  };

  callSendAPI(messageData);
}

function contains(a, obj) {
    var i = a.length;
    while (i--) {
       if (a[i] === obj) {
           return true;
       }
    }
    return false;
}

function graphpagerequests(recipientid, requeststring) {
	return new Promise(function(resolve, reject) {
    // Do the usual XHR stuff
	var success = '0';
	//FB Error message set up.
	var generic_error_message='Oops. Something went awry. I have no clue what went wrong. How about trying another page?'; // Ezt kapja, ha nem azonosítottuk a hiba okát.
	//Az üzenetet az elérhető infóval a különböző logikai vizsgálatok alapján feltöltjük tartalommal. 
	//Ha nem kapna tartalmat, az általános hibára inicializáljuk. 
	var errormessage=generic_error_message; 
	
	graph
	.setAccessToken(WORKER_PAGE_ACCESS_TOKEN)
	.setOptions(options)
	.get(requeststring , function(err, fbresponse) {
		console.log('Raw Fb response: ' + JSON.stringify(fbresponse));
		//var error10=JSON.parse('{"error":{"message":"(#10) To use Page Public Content Access, your use of this endpoint must be reviewed and approved by Facebook. To submit this Page Public Content Access feature for review please read our documentation on reviewable features: https://developers.facebook.com/docs/apps/review.","type":"OAuthException","code":10,"fbtrace_id":"ACGe5z+R+cc"}}');
		//var error803=JSON.parse('{"error": {"message": "(#803) Some of the aliases you requested do not exist: gyurcsany","type": "OAuthException","code": 803,"fbtrace_id": "BEr8GHLx8bd"}}');
		//var error190=JSON.parse('{"error":{"message":"Invalid OAuth access token signature.","type":"OAuthException","code":190,"fbtrace_id":"GQWHG+ETnCz"}}');
		//var error1=JSON.parse('{"error":{"message":"Invalid OAuth access token signature.","type":"OAuthException","code":1,"fbtrace_id":"GQWHG+ETnCz"}}');
		//var error0=JSON.parse('{"error":{"message":"Invalid OAuth access token signature.","type":"OAuthException","fbtrace_id":"GQWHG+ETnCz"}}');
		//fbresponse=error803;
		
		if (fbresponse && fbresponse['error']) {
			// extract the error from the json
			console.log('Graph api error!!!!');
			var error=fbresponse['error'];
			if (error && error['code']) {
			// extract the error code
				var code=error['code'];
				console.log(code);
				//Let the message be appropriate to the error code
				switch (code) {
					case 10:
						errormessage='I am totally ruffled right now. Please excuse my confusion. I am still waiting to pass the review by Facebook to be able to serve you.';
					break;

					case 803:
						errormessage='I could not find this page on Facebook. Your fault, not mine. Twitter a page that exists!';
					break;

					case 190:
						errormessage='Oh my! I am too blushed for a bird right now. There is a problem with my Fb authentication. Please excuse me, but I cannot respond to your queries right now.';
						break;

					default:
						//Generic error message. 
						//message='Ooops! There was an error. How about trying another page?';
						errormessage=generic_error_message;
				}
			
			} else {
			//Generic error message. 
			//message='Ooops! There was an error. How about trying another page?';
			errormessage=generic_error_message + 'Facebook tells me there is an error, but it is not clear what it is.' ;
			}
			reject({'recipient':recipientid, 'response':errormessage});
		} else {if (fbresponse && fbresponse['category']) {
			resolve({'recipient':recipientid, 'response':fbresponse}); //This is the meat of the application
			} else {
				errormessage='I am totally ruffled right now. Please excuse my confusion. I am still waiting to pass the review by Facebook to be able to serve you.'
				reject({'recipient':recipientid, 'response':errormessage});
				
			}
		}
	
		
		});	


  });
	


}

function graphlikerequests(recipientid, requeststring) {
	return new Promise(function(resolve, reject) {
    // Do the usual XHR stuff
	var success = '0';
	//FB Error message set up.
	var generic_error_message='Generic error message'; // Ezt kapja, ha nem azonosítottuk a hiba okát.
	//Az üzenetet az elérhető infóval a különböző logikai vizsgálatok alapján feltöltjük tartalommal. 
	//Ha nem kapna tartalmat, az általános hibára inicializáljuk. 
	var errormessage=generic_error_message; 
	
	graph
	.setAccessToken(WORKER_PAGE_ACCESS_TOKEN)
	.setOptions(options)
	.get(requeststring , function(err, fbresponse) {
		console.log('Raw Fb response: ' + JSON.stringify(fbresponse));
		//var error10=JSON.parse('{"error":{"message":"(#10) To use Page Public Content Access, your use of this endpoint must be reviewed and approved by Facebook. To submit this Page Public Content Access feature for review please read our documentation on reviewable features: https://developers.facebook.com/docs/apps/review.","type":"OAuthException","code":10,"fbtrace_id":"ACGe5z+R+cc"}}');
		//var error803=JSON.parse('{"error": {"message": "(#803) Some of the aliases you requested do not exist: gyurcsany","type": "OAuthException","code": 803,"fbtrace_id": "BEr8GHLx8bd"}}');
		//var error190=JSON.parse('{"error":{"message":"Invalid OAuth access token signature.","type":"OAuthException","code":190,"fbtrace_id":"GQWHG+ETnCz"}}');
		//var error1=JSON.parse('{"error":{"message":"Invalid OAuth access token signature.","type":"OAuthException","code":1,"fbtrace_id":"GQWHG+ETnCz"}}');
		//var error0=JSON.parse('{"error":{"message":"Invalid OAuth access token signature.","type":"OAuthException","fbtrace_id":"GQWHG+ETnCz"}}');
		//fbresponse=error803;
		
		if (fbresponse && fbresponse['error']) {
			// extract the error from the json
			console.log('Graph api error!!!!');
			var error=fbresponse['error'];
			if (error && error['code']) {
			// extract the error code
				var code=error['code'];
				console.log(code);
				//Let the message be appropriate to the error code
				switch (code) {
					case 10:
						errormessage='I am totally ruffled right now. Please excuse my confusion. I am still waiting to pass the review by Facebook to be able to serve you.';
					break;

					case 803:
						errormessage='I could not find this page on Facebook. Your fault, not mine. Twitter a page that exists!';
					break;

					case 190:
						errormessage='Oh my! I am too blushed for a bird right now. There is a problem with my Fb authentication. Please excuse me, but I cannot respond to your queries right now.';
						break;

					default:
						//Generic error message. 
						//message='Ooops! There was an error. How about trying another page?';
						errormessage=generic_error_message ;
				}
			
			} else {
			//Generic error message. 
			//message='Ooops! There was an error. How about trying another page?';
			errormessage=generic_error_message + ' No code in error message' ;
			}
			reject({'recipient':recipientid, 'response':errormessage});
		} else {if (fbresponse && fbresponse['data']) {
			resolve({'recipient':recipientid, 'response':fbresponse['data']}); //This is the meat of the application
			} else {
				errormessage='I am totally ruffled right now. Please excuse my confusion. I am still waiting to pass the review by Facebook to be able to serve you.'
				reject({'recipient':recipientid, 'response':errormessage});
				
			}
		}
	
		
		});	

  });

}

function parseinput(recipient, adr){
	var parsed_adr = url.parse(adr, true);
	var path=parsed_adr.pathname;
	console.log(path);

	if (path[path.length-1]==match) {
		path=path.slice(0, -1);
		console.log(path + '  A végéről levettem a slasht.');
	} 

	if (path[0]==match) {
		path=path.substr(1);
		console.log(path + '  Az elejéről levettem a slasht.');
	} 

	path = path.slice(path.lastIndexOf('-')+1);

	var slashcount=(path.match(/\//g) || []).length;
	console.log('Number of slashes in string: ' + slashcount);

	if (slashcount == 0) {
		console.log(path + '  Ezt már le is lehet kérni a FB-tól.');
			var pageoutput;
			var likeoutput;
			graphpagerequests(recipient, path+ '?fields=name,category').then(function(response) {
				pageoutput=response['response'];
				//console.log("Success graphpagerequest! ... ", response)
				graphlikerequests(response['recipient'], path+'/likes?fields=name,category').then(function(response) {
					//var recipientfbid=response['recipient'];
					//console.log(recipientfbid)
					likeoutput=response['response'];
					//console.log("Success graphlikerequest! ... ", response);
					//console.log('This is the result of both requests: ');
					//console.log(pageoutput);
					//console.log(likeoutput);					
					var pagecat=pageoutput['category'];
					var pagename=pageoutput['name'];
					var likecount=0;
					var samelikecount=0;
					var uniquelikecount=0;
					var likecats=[];
					var uniquelikestring='';
					var uniquelikecats=[];
					var forcount=0;	
					var firstmessage='';
					var secondmessage='';
					var pageorpages=' page ';					
					for (forcount=0; forcount < likeoutput.length; forcount++) {						
						likecount++;
						var like=likeoutput[forcount];
						console.log('Itt tart a for loop ' + forcount);
						likecats.push(like['category']);						
						if (like['category']==pagecat){
							samelikecount++;
							//console.log(samelikecount);
							}
						}
					console.log('Likes in the same category:  ' + samelikecount);
					console.log('Number of likes: ' + likecount);
					console.log(likecats);
					for (forcount=0; forcount < likecats.length; forcount++) {
						var likecat=likecats[forcount];
						if (!contains(uniquelikecats, likecat)){
							uniquelikecats.push(likecat);
							uniquelikecount++;
							uniquelikestring=uniquelikestring+likecat+', '  ;
							}
						}
					console.log('Number of unique like categories: ' + uniquelikecount);
					console.log(uniquelikecats);
					//Response messages are constructed.
					if (uniquelikestring.length>0){
						secondmessage='The kinds of pages liked by this page: ' + uniquelikestring.slice(0,-2)+'.';
					}
					//Response messages are constructed.
					if (samelikecount>1){pageorpages=' pages '}
					firstmessage='The page ' + pagename + ' belongs to the Category ' + pagecat + '. This page 💚 likes ' + samelikecount + pageorpages + 'in the same Category, out of a total of ' + likecount + ' pages liked.';
				
				
					//console.log(firstmessage);
					//console.log(secondmessage);
					//console.log(thirdmessage);
					sendTextMessage(response['recipient'], firstmessage);
					sendTextMessage(response['recipient'], secondmessage);
					

					}, function(error) {						
					sendTextMessage(error['recipient'], error['response']);						
					//console.log("Failed graphlikerequest! ...");
					}
				);
			
			;
			}, function(error) {
			sendTextMessage(error['recipient'], error['response']);
			//console.log("Failed graphpagerequest! ...");
			});


		
	} else {
	
		sendTextMessage(recipient,'I could not find this page on Facebook. Your fault, not mine. Chirp in with a page that exists!');
	}	
}



function sendGraph(recipientId, messageText) {
	parseinput(recipientId,messageText);
}


/*
 * Send a button message using the Send API.
 *
 */
function sendButtonMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "This is test text",
          buttons:[{
            type: "web_url",
            url: "https://www.oculus.com/en-us/rift/",
            title: "Open Web URL"
          }, {
            type: "postback",
            title: "Trigger Postback",
            payload: "DEVELOPER_DEFINED_PAYLOAD"
          }, {
            type: "phone_number",
            title: "Call Phone Number",
            payload: "+16505551234"
          }]
        }
      }
    }
  };  

  callSendAPI(messageData);
}

/*
 * Send a Structured Message (Generic Message type) using the Send API.
 *
 */
function sendGenericMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [{
            title: "rift",
            subtitle: "Next-generation virtual reality",
            item_url: "https://www.oculus.com/en-us/rift/",               
            image_url: SERVER_URL + "/assets/rift.png",
            buttons: [{
              type: "web_url",
              url: "https://www.oculus.com/en-us/rift/",
              title: "Open Web URL"
            }, {
              type: "postback",
              title: "Call Postback",
              payload: "Payload for first bubble",
            }],
          }, {
            title: "touch",
            subtitle: "Your Hands, Now in VR",
            item_url: "https://www.oculus.com/en-us/touch/",               
            image_url: SERVER_URL + "/assets/touch.png",
            buttons: [{
              type: "web_url",
              url: "https://www.oculus.com/en-us/touch/",
              title: "Open Web URL"
            }, {
              type: "postback",
              title: "Call Postback",
              payload: "Payload for second bubble",
            }]
          }]
        }
      }
    }
  };  

  callSendAPI(messageData);
}

/*
 * Send a receipt message using the Send API.
 *
 */
function sendReceiptMessage(recipientId) {
  // Generate a random receipt ID as the API requires a unique ID
  var receiptId = "order" + Math.floor(Math.random()*1000);

  var messageData = {
    recipient: {
      id: recipientId
    },
    message:{
      attachment: {
        type: "template",
        payload: {
          template_type: "receipt",
          recipient_name: "Peter Chang",
          order_number: receiptId,
          currency: "USD",
          payment_method: "Visa 1234",        
          timestamp: "1428444852", 
          elements: [{
            title: "Oculus Rift",
            subtitle: "Includes: headset, sensor, remote",
            quantity: 1,
            price: 599.00,
            currency: "USD",
            image_url: SERVER_URL + "/assets/riftsq.png"
          }, {
            title: "Samsung Gear VR",
            subtitle: "Frost White",
            quantity: 1,
            price: 99.99,
            currency: "USD",
            image_url: SERVER_URL + "/assets/gearvrsq.png"
          }],
          address: {
            street_1: "1 Hacker Way",
            street_2: "",
            city: "Menlo Park",
            postal_code: "94025",
            state: "CA",
            country: "US"
          },
          summary: {
            subtotal: 698.99,
            shipping_cost: 20.00,
            total_tax: 57.67,
            total_cost: 626.66
          },
          adjustments: [{
            name: "New Customer Discount",
            amount: -50
          }, {
            name: "$100 Off Coupon",
            amount: -100
          }]
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a message with Quick Reply buttons.
 *
 */
function sendQuickReply(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: "What's your favorite movie genre?",
      quick_replies: [
        {
          "content_type":"text",
          "title":"Action",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_ACTION"
        },
        {
          "content_type":"text",
          "title":"Comedy",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_COMEDY"
        },
        {
          "content_type":"text",
          "title":"Drama",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_DRAMA"
        }
      ]
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a read receipt to indicate the message has been read
 *
 */
function sendReadReceipt(recipientId) {
  console.log("Sending a read receipt to mark message as seen");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "mark_seen"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator on
 *
 */
function sendTypingOn(recipientId) {
  console.log("Turning typing indicator on");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_on"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator off
 *
 */
function sendTypingOff(recipientId) {
  console.log("Turning typing indicator off");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_off"
  };

  callSendAPI(messageData);
}

/*
 * Send a message with the account linking call-to-action
 *
 */
function sendAccountLinking(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "Welcome. Link your account.",
          buttons:[{
            type: "account_link",
            url: SERVER_URL + "/authorize"
          }]
        }
      }
    }
  };  

  callSendAPI(messageData);
}

/*
 * Call the Send API. The message data goes in the body. If successful, we'll 
 * get the message id in a response 
 *
 */
function callSendAPI(messageData) {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json: messageData

  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;

      if (messageId) {
        console.log("Successfully sent message with id %s to recipient %s", 
          messageId, recipientId);
      } else {
      console.log("Successfully called Send API for recipient %s", 
        recipientId);
      }
    } else {
      console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
    }
  });  
}

// Start server
// Webhooks must be available via SSL with a certificate signed by a valid 
// certificate authority.
app.listen(app.get('port'), function() {
  console.log('Node app is running on port', app.get('port'));
});

module.exports = app;


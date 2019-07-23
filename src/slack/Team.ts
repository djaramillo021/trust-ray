import * as winston from "winston";
const querystring = require("querystring");
const axios = require('axios');

class TeamMessage {
      private URL_MSG: string = "https://slack.com/api/chat.postMessage?";
      private TOKEN: string = process.env.SLACK_TOKEN || null;
      private CHANNEL: string = process.env.SLACK_CHANNEL || null;

      async sendMessage(message: string) {
            try {
                  const url: string = `${this.URL_MSG}token=${this.TOKEN}&channel=${this.CHANNEL}&${querystring.stringify({ text: message })}&pretty=1`;
                  await axios.get(url);

            } catch (error) {
                  winston.error(`Slack sendMessage error: ` + error);
            }

      }



}
export default TeamMessage;
// iplaces: subjects and sign-offs use the station title ({{ brandName }},
// Settings > Configuration > Group Identity > Group name) instead of
// "Kotahi". Only seeds a NEW group; existing stations are fixed in Emails.
module.exports = [
  {
    emailTemplateKey: 'genericTaskNotificationEmailTemplate',
    description: 'Task notification',
    subject: '{{ brandName }} | Task notification',
    ccEditors: false,
    body: `<p>
        <p>Dear {{ recipientName }},</p>
        <p>A task requires your attention<br />
        {{{ manuscriptLink }}}
        </p>
        <p>Regards, <br>
          {{ brandName }} team
        </p>`,
  },
  {
    emailTemplateKey: 'authorInvitationEmailTemplate',
    description: 'Author Invitation',
    subject: '{{ brandName }} | Permission to review',
    ccEditors: false,
    type: 'authorInvitation',
    body: `<p>Dear {{ recipientName }},</p>
        <p>
          The manuscript titled “{{ manuscriptTitle }}” has been selected for peer review. Click on the link below to accept or decline the invitation;
        </p>
        <p>{{{ acceptInviteLink }}}</p>
        <p>{{{ declineInviteLink }}}</a></p>
        <p>
        Please note; that you will require an ORCID account in order to log in. If you don’t already have an account, it takes 2 mins to <a href="https://orcid.org/register" target="_blank">register a new ORCID account here</a>. <br>
        </p>
        <p>
        Regards, <br>
        {{ brandName }} team
      </p>`,
  },
  {
    emailTemplateKey: 'reviewerInvitationEmailTemplate',
    description: 'Reviewer Invitation',
    subject: '{{ brandName }} | Reviewer invitation',
    ccEditors: false,
    type: 'reviewerInvitation',
    body: `
        <p>
          <p>Dear {{ recipientName }},</p>
          <p>
              You have been selected to peer review the manuscript titled “{{ manuscriptTitle }}”. Click on the link below to accept or decline the invitation;
          </p>
          <p>{{{ acceptInviteLink }}}</p>
          <p>{{{ declineInviteLink }}}</a></p>
          <p>
              Please note; that you will require an ORCID account in order to log in. If you don’t already have an account, it takes 2 mins to <a href="https://orcid.org/register" target="_blank">register a new ORCID account here</a>. <br>
          </p>
          <p>
              Regards, <br>
              {{ brandName }} team
          </p>
      </p>`,
  },
  {
    emailTemplateKey: 'collabroativeReviewerInvitationEmailTemplate',
    description: 'Collaborative Reviewer Invitation',
    subject: '{{ brandName }} | Collaborative Reviewer invitation',
    ccEditors: false,
    type: 'collaborativeReviewerInvitation',
    body: `
        <p>
          <p>Dear {{ recipientName }},</p>
          <p>
              You have been selected to collaborate on peer review with manuscript titled “{{ manuscriptTitle }}”. Click on the link below to accept or decline the invitation;
          </p>
          <p>{{{ acceptInviteLink }}}</p>
          <p>{{{ declineInviteLink }}}</a></p>
          <p>
              Please note; that you will require an ORCID account in order to log in. If you don’t already have an account, it takes 2 mins to <a href="https://orcid.org/register" target="_blank">register a new ORCID account here</a>. <br>
          </p>
          <p>
              Regards, <br>
              {{ brandName }} team
          </p>
      </p>`,
  },
  {
    emailTemplateKey: 'chatNotification',
    description: 'Chat notification',
    subject: '{{ brandName }} | Discussion notification',
    ccEditors: false,
    type: 'systemEmail',
    body: `<p>
        <p>Dear {{ recipientName }},</p>

        <p>You have new discussion messages. Click here to reply; {{{ discussionUrl }}}</p>
        <p>Want to change your notifications settings? Log in to {{ brandName }} and go to your profile page<br></p>
        <p>Regards, <br>
          {{ brandName }} team
        </p>`,
  },
  {
    emailTemplateKey: 'authorProofingInvitationEmailTemplate',
    description: 'Author proofing invitation',
    subject: '{{ brandName }} | You’ve been assigned to proof {{ manuscriptTitle }}',
    ccEditors: false,
    type: 'authorProofingInvitation',
    body: `
        <p>
          <p>Dear {{ recipientName }},</p>
          <p>
              You have been assigned to participate in a round of author proofing. Click here to access the manuscript and feedback form;
          </p>
          <p>{{{ manuscriptProductionLink }}}</p>
          <p>
              Regards, <br>
              {{ brandName }} team
          </p>
      </p>`,
  },
  {
    emailTemplateKey: 'authorProofingSubmittedEmailTemplate',
    description: 'Author proofing submitted',
    subject:
      '{{ brandName }} | {{ senderName }} has completed proofing {{ manuscriptTitle }}',
    ccEditors: false,
    type: 'authorProofingSubmitted',
    body: `
        <p>
          <p>Dear {{ recipientName }},</p>
          <p>
              An author you have assigned has completed a round of author proofing. Click here to access the manuscript and feedback form;
          </p>
          <p>{{{ manuscriptProductionLink }}}</p>
          <p>
              Regards, <br>
              {{ brandName }} team
          </p>
      </p>`,
  },
]

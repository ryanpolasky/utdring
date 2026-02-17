![GitHub code size in bytes](https://img.shields.io/github/languages/code-size/ryanpolasky/utdring.svg)
[![W3C Validation - https://validator.nu/](https://img.shields.io/w3c-validation/default?targetUrl=https%3A%2F%2Fcs.utdring.com%2F&label=w3c%20check)](https://validator.nu/?doc=https%3A%2F%2Fcs.utdring.com%2F)
![GitHub stars](https://img.shields.io/github/stars/ryanpolasky/utdring.svg?style=social)

<figure>
  <img src="./webAssets//og.png" alt="Thumbnail logo">
  <figcaption style="text-align: center; font-style: italic;">
    A webring for Computer Science students and alumni at the University of Texas at Dallas. If you're one of us, we welcome you with open arms. Visit our live site <a href="https://cs.utdring.com">here</a>.
  </figcaption>
</figure>

## Joining the Webring

1. Add the webring widget to your website HTML ([template below](#widget-template)). Generally, you should add it to the footer.
2. Clone this repo, branch, and add your information to the **BOTTOM** of `webringData[]` in `index.html` following this format:
   ```json
   {
     "name": "Your Name",
     "website": "https://your-website.com",
     "year": "20XX"
   }
   ```
3. Submit a Pull Request! We'll try to review as fast as we can.

## Widget template

<img width="134" height="54" alt="image" src="https://github.com/user-attachments/assets/f9fd8af8-5c18-42f2-ac59-ebf0df964b26" />

Since every website is unique, we suggest you add your own flair to the UTD emblem. We also know that design is hard, so here are some examples to get you started:

#### HTML:

```html
<div style="display: flex; align-items: center; gap: 8px;">
    <a href="https://cs.utdring.com/#your-site-here?nav=prev">←</a>
    <a href="https://cs.utdring.com/#your-site-here" target="">
        <img src="https://cs.utdring.com/icon.black.svg" alt="CS Webring" style="width: 24px; height: auto; opacity: 0.8;"/>
    </a>
    <a href="https://cs.utdring.com/#your-site-here?nav=next">→</a>
</div>
<!-- Replace 'your-site-here' with your actual site URL -->
```

#### JSX:

```jsx
<div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
    <a href='https://cs.utdring.com/#your-site-here?nav=prev'>←</a>
    <a href='https://cs.utdring.com/#your-site-here' target=''>
        <img
            src='https://cs.utdring.com/icon.black.svg'
            alt='CS Webring'
            style={{ width: '24px', height: 'auto', opacity: 0.8 }}
        />
    </a>
    <a href='https://cs.utdring.com/#your-site-here?nav=next'>→</a>
</div>
// Replace 'your-site-here' with your actual site URL
```

For dark-themed websites, use `icon.white.svg`. Feel free to host the icon locally if you encounter HTTPS issues / styling issues.

## Alternative Icons Sources

- Black: `https://cs.utdring.com/icon.black.svg`
- White: `https://cs.utdring.com/icon.white.svg`
- Red: `https://cs.utdring.com/icon.red.svg`

If none of these quite work for you, feel free to make your own. If you're using React, start with [icon.custom.tsx](./icon.custom.tsx).

## Q&A

#### _I'm not in CS. Can I still join?_

> No :) 
> 
> In all realness, this is the only existing webring at UT Dallas as far as I'm aware. They aren't too complex to make & can be a great way to connect with bright minds, so consider creating your own!

#### _Do you accept alumni and post-grad students?_

> Yep, as long as you studied Computer Science or are currently studying it

#### _What about minors, double degrees (ie CS BBA), etc?_

> 👍

## Credits & Inspiration

This project is (obviously) forked from the [UWaterloo CS webring](https://cs.uwatering.com/), so credit goes to them for creating such a well polished site! 

I (Ryan) currently maintain the site, so if you see any bugs please let me know by making an issue. I'll try to respond as fast as I can :)

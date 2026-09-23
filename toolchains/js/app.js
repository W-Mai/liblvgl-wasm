function main(api) {
  const button = api.runtime.createButton(api.screen);
  button.setSize(180, 64);
  button.setPosition(70, 88);
  const label = api.runtime.createLabel(button);
  api.runtime.setText(label, "JS application");
  button.on(api.runtime.clickedEvent, () => {
    api.runtime.setText(label, "JS clicked");
    api.log("JS clicked");
  });
}

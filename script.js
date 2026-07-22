const form = document.getElementById("stock-form");
const result = document.getElementById("stock-result");

form.addEventListener("submit", function (event) {
  event.preventDefault();

  const productName = document.getElementById("product-name").value;
  const currentStock = Number(
    document.getElementById("current-stock").value
  );
  const reorderLevel = Number(
    document.getElementById("reorder-level").value
  );

  if (currentStock <= reorderLevel) {
    result.textContent =
      productName + " is low in stock and needs to be reordered.";
    result.className = "low-stock";
  } else {
    result.textContent =
      productName + " has enough stock right now.";
    result.className = "enough-stock";
  }
});